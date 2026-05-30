#!/usr/bin/env python3
"""
Stale Device ID Diagnostic Agent

Detects Telegram connections that have gone stale after explicit deactivation.
The server still holds the chatId as "active" in memory, but Telegram silently
returns 403 Forbidden because the user blocked the bot — a classic auth-state
bug with no visible error on the client side.

Runs at least MIN_ITERATIONS diagnostic passes, probing stale candidates against
the live Telegram API and writing a structured JSON report.

Usage:
    python scripts/stale_device_diagnostic.py
    python scripts/stale_device_diagnostic.py --iterations 15 --send-email

Cron (daily 09:00):
    0 9 * * * cd /opt/thechat && python scripts/stale_device_diagnostic.py --send-email >> logs/diagnostic.log 2>&1

Required env vars (see .env):
    TELEGRAM_TOKEN or TELEGRAM_BOT_TOKEN   — bot API token
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  — for email reports
    DIAGNOSTIC_REPORT_EMAIL                — recipient address
"""

import argparse
import json
import logging
import os
import smtplib
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# ── bootstrap ────────────────────────────────────────────────────────────────

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / '.env')
except ImportError:
    pass  # dotenv optional; env vars may already be set by the shell

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s  %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S',
)
log = logging.getLogger('stale-device-diag')

# ── constants ─────────────────────────────────────────────────────────────────

ROOT_DIR = Path(__file__).parent.parent
USER_MEMORY_DIR = ROOT_DIR / 'data' / 'user_memory'
REPORTS_DIR = ROOT_DIR / 'data' / 'diagnostic_reports'

MIN_ITERATIONS = 10

# idle-time thresholds (ms) that map to each tier
TIER_THRESHOLDS_MS = {
    1: 6 * 3600 * 1000,
    2: 24 * 3600 * 1000,
    3: 72 * 3600 * 1000,
    4: 7 * 24 * 3600 * 1000,
}

TELEGRAM_REQUEST_TIMEOUT = 10  # seconds

# ── Telegram helpers ──────────────────────────────────────────────────────────

def _telegram_api_base(token: str) -> str:
    return f'https://api.telegram.org/bot{token}'


def _probe_chat(api_base: str, chat_id: str) -> dict:
    """
    Call getChat to check if the bot can still reach this user.
    Returns a dict with ok, error_code, description.
    A 403 means the user explicitly blocked the bot.
    """
    url = f'{api_base}/getChat'
    payload = json.dumps({'chat_id': chat_id}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=TELEGRAM_REQUEST_TIMEOUT, context=ctx) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read())
        except Exception:
            data = {'ok': False, 'error_code': exc.code, 'description': str(exc)}
    except Exception as exc:
        data = {'ok': False, 'error_code': None, 'description': str(exc)}

    return {
        'chat_id': chat_id,
        'ok': bool(data.get('ok', False)),
        'error_code': data.get('error_code'),
        'description': str(data.get('description', '')),
    }


def _is_blocked_response(result: dict) -> bool:
    code = result.get('error_code')
    desc = result.get('description', '').lower()
    return (
        code == 403
        or 'blocked by the user' in desc
        or 'user is deactivated' in desc
        or 'chat not found' in desc
    )


# ── Memory helpers ────────────────────────────────────────────────────────────

def _load_memories() -> list[dict]:
    if not USER_MEMORY_DIR.exists():
        log.warning('User memory dir not found: %s', USER_MEMORY_DIR)
        return []
    mems = []
    for f in sorted(USER_MEMORY_DIR.glob('*.json')):
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            data['_file'] = str(f)
            mems.append(data)
        except Exception as exc:
            log.warning('Skipping %s: %s', f.name, exc)
    return mems


def _get_tier(last_seen_ms: int) -> int:
    idle = max(0, int(time.time() * 1000) - last_seen_ms)
    for tier in (4, 3, 2, 1):
        if idle > TIER_THRESHOLDS_MS[tier]:
            return tier
    return 0


def _classify(mem: dict) -> str:
    """
    blocked         — already confirmed blocked (connection.blocked set)
    stale_candidate — tier has escalated but pings are not advancing;
                      possible silent 403 that the recall worker missed
    healthy         — tier <= lastTier or was recently pinged
    inactive        — lastSeen == 0, never connected
    """
    if mem.get('connection', {}).get('blocked'):
        return 'blocked'

    last_seen = mem.get('activity', {}).get('lastSeen', 0)
    if not last_seen:
        return 'inactive'

    last_ping = mem.get('activity', {}).get('lastPing', 0)
    last_tier = mem.get('activity', {}).get('lastTier', 0)
    tier = _get_tier(last_seen)

    if tier <= 0:
        return 'healthy'

    if tier > last_tier:
        # Tier escalated. If we have a prior lastPing that hasn't moved
        # despite a full tier interval passing, the device is likely blocked.
        if last_ping > 0:
            idle_since_ping_ms = max(0, int(time.time() * 1000) - last_ping)
            threshold = TIER_THRESHOLDS_MS.get(tier, TIER_THRESHOLDS_MS[1]) * 2
            if idle_since_ping_ms > threshold:
                return 'stale_candidate'

    return 'healthy'


# ── Diagnostic loop ───────────────────────────────────────────────────────────

def run_diagnostics(iterations: int, token: str | None) -> dict:
    """
    Run `iterations` diagnostic passes (minimum MIN_ITERATIONS).
    Each pass re-reads memory files so the worker's blocked-flags are visible
    if the recall worker ran in the meantime.
    """
    n = max(MIN_ITERATIONS, iterations)
    log.info('Starting diagnostic  iterations=%d', n)

    report: dict = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'iterations': n,
        'users_total': 0,
        'by_classification': {
            'blocked': [],
            'stale_candidate': [],
            'healthy': [],
            'inactive': [],
        },
        'connection_checks': [],
        'candidates_confirmed_blocked': [],
        'summary': {},
    }

    api_base = _telegram_api_base(token) if token else None

    for iteration in range(1, n + 1):
        log.info('Iteration %d/%d', iteration, n)

        # Re-load memories each pass so incremental fixes are reflected
        memories = _load_memories()
        report['users_total'] = len(memories)

        classified: dict[str, list[str]] = {
            'blocked': [], 'stale_candidate': [], 'healthy': [], 'inactive': []
        }
        for mem in memories:
            uid = str(mem.get('userId', mem.get('_file', '?')))
            cls = _classify(mem)
            classified[cls].append(uid)

        report['by_classification'] = classified

        candidates = classified['stale_candidate']
        log.info(
            '  blocked=%d  stale_candidates=%d  healthy=%d  inactive=%d',
            len(classified['blocked']),
            len(candidates),
            len(classified['healthy']),
            len(classified['inactive']),
        )

        # Probe a slice of stale candidates against the live API
        if api_base and candidates:
            # Spread candidates evenly across iterations
            slice_size = max(1, (len(candidates) + n - 1) // n)
            start = ((iteration - 1) * slice_size) % len(candidates)
            batch = candidates[start: start + slice_size]

            with ThreadPoolExecutor(max_workers=min(5, len(batch))) as pool:
                futures = {pool.submit(_probe_chat, api_base, cid): cid for cid in batch}
                for fut in as_completed(futures):
                    result = fut.result()
                    result['iteration'] = iteration
                    report['connection_checks'].append(result)

                    if _is_blocked_response(result):
                        cid = result['chat_id']
                        if cid not in report['candidates_confirmed_blocked']:
                            report['candidates_confirmed_blocked'].append(cid)
                            log.warning(
                                'CONFIRMED BLOCKED  user=%s  reason=%s',
                                cid, result['description'],
                            )
        elif not api_base:
            log.info('  no TELEGRAM_TOKEN — skipping live probes this pass')

        # Short pause to avoid hammering Telegram rate limits
        if iteration < n:
            time.sleep(0.3)

    report['summary'] = {
        'total_users': report['users_total'],
        'blocked_known': len(report['by_classification']['blocked']),
        'stale_candidates': len(report['by_classification']['stale_candidate']),
        'candidates_confirmed_blocked': len(report['candidates_confirmed_blocked']),
        'healthy': len(report['by_classification']['healthy']),
        'inactive': len(report['by_classification']['inactive']),
    }
    log.info('Diagnostic complete  summary=%s', report['summary'])
    return report


# ── Email report ──────────────────────────────────────────────────────────────

def _build_report_text(report: dict) -> str:
    s = report['summary']
    confirmed = report['candidates_confirmed_blocked']
    lines = [
        'Stale Device ID Diagnostic Report',
        f"Generated : {report['timestamp']}",
        f"Iterations: {report['iterations']}",
        '',
        'SUMMARY',
        '-------',
        f"Total users in memory    : {s['total_users']}",
        f"Already marked blocked   : {s['blocked_known']}",
        f"Stale candidates checked : {s['stale_candidates']}",
        f"Newly confirmed blocked  : {s['candidates_confirmed_blocked']}",
        f"Healthy                  : {s['healthy']}",
        f"Inactive (never seen)    : {s['inactive']}",
        '',
    ]

    if confirmed:
        lines += [
            'NEWLY CONFIRMED BLOCKED DEVICES',
            '--------------------------------',
        ]
        for cid in confirmed:
            lines.append(f'  chatId: {cid}')
        lines += [
            '',
            'Action: these users will be auto-marked connection.blocked=true',
            '             on the next recall-worker run (already deployed).',
            '',
        ]

    lines += [
        'ROOT-CAUSE HYPOTHESIS',
        '---------------------',
        'A user who blocked the bot still has an "active" entry in user_memory.',
        'The recall worker sent messages that Telegram rejected with 403 Forbidden',
        'but the error was not persisted — the device ID stayed "live" in memory.',
        '',
        'FIX DEPLOYED',
        '------------',
        '  modules/memory/user_memory.cjs  — added connection.{blocked,blockedAt}',
        '  scripts/unified_recall_worker.cjs — 403/blocked errors now set',
        '     memory.connection.blocked=true and skip the user on future runs.',
    ]
    return '\n'.join(lines)


def send_email_report(report: dict) -> bool:
    cfg = {
        'host': os.getenv('SMTP_HOST', ''),
        'port': int(os.getenv('SMTP_PORT', '587')),
        'user': os.getenv('SMTP_USER', ''),
        'password': os.getenv('SMTP_PASS', ''),
        'to': os.getenv('DIAGNOSTIC_REPORT_EMAIL') or os.getenv('ADMIN_EMAIL', ''),
    }
    if not all([cfg['host'], cfg['user'], cfg['password'], cfg['to']]):
        log.warning(
            'Email skipped — set SMTP_HOST, SMTP_USER, SMTP_PASS, DIAGNOSTIC_REPORT_EMAIL'
        )
        return False

    s = report['summary']
    subject = (
        f"[Nyxa Diagnostic] {s['candidates_confirmed_blocked']} newly blocked, "
        f"{s['stale_candidates']} stale candidates"
    )
    body = _build_report_text(report)
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = cfg['user']
    msg['To'] = cfg['to']
    msg.attach(MIMEText(body, 'plain'))

    try:
        with smtplib.SMTP(cfg['host'], cfg['port'], timeout=15) as server:
            server.ehlo()
            server.starttls()
            server.login(cfg['user'], cfg['password'])
            server.sendmail(cfg['user'], cfg['to'], msg.as_string())
        log.info('Email report sent to %s', cfg['to'])
        return True
    except Exception as exc:
        log.error('Failed to send email: %s', exc)
        return False


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Stale Device ID Diagnostic Agent',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        '--iterations', type=int, default=MIN_ITERATIONS,
        help=f'Diagnostic passes to run (minimum {MIN_ITERATIONS}, default {MIN_ITERATIONS})',
    )
    parser.add_argument(
        '--send-email', action='store_true',
        help='Send email report when done',
    )
    args = parser.parse_args()

    token = os.getenv('TELEGRAM_TOKEN') or os.getenv('TELEGRAM_BOT_TOKEN', '')
    if not token:
        log.warning('TELEGRAM_TOKEN not set — live probes disabled')

    report = run_diagnostics(args.iterations, token or None)

    # Persist report
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts_slug = datetime.now().strftime('%Y%m%d_%H%M%S')
    report_path = REPORTS_DIR / f'stale_device_{ts_slug}.json'
    report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    log.info('Report saved: %s', report_path)

    if args.send_email:
        send_email_report(report)

    # Exit 1 when new blocked devices are found so cron can alert
    if report['summary']['candidates_confirmed_blocked'] > 0:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
