<?php

class LeadEngine {

    private static $data;
    private static $dataFile;

    // Status-Pipeline
    const STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

    // Score-Schwellen
    const SCORE_QUALIFIED  = 30;
    const SCORE_HOT        = 60;

    public static function load() {

        self::$dataFile = __DIR__.'/../../data/leads/leads.json';

        if (!file_exists(self::$dataFile)) {
            self::$data = [ "leads" => [] ];
            self::save();
        }

        self::$data = json_decode(file_get_contents(self::$dataFile), true);
        $count = count(self::$data['leads']);
        echo "[LEAD-ENGINE] Loaded — {$count} leads\n";
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    public static function capture($name, $email, $source = 'website', $interest = 'general', $metadata = []) {

        // Duplicate check by email
        foreach (self::$data['leads'] as $lead) {
            if (strtolower($lead['email']) === strtolower($email)) {
                echo "[LEAD-ENGINE] Duplicate: {$email}\n";
                return $lead;
            }
        }

        $id = 'lead_' . substr(md5($email . microtime()), 0, 8);

        $lead = [
            'id'        => $id,
            'name'      => $name,
            'email'     => $email,
            'source'    => $source,
            'interest'  => $interest,
            'status'    => 'new',
            'score'     => self::initialScore($source, $interest),
            'notes'     => [],
            'agent_id'  => null,
            'metadata'  => $metadata,
            'created'   => date('c'),
            'updated'   => date('c')
        ];

        self::$data['leads'][] = $lead;
        self::save();
        echo "[LEAD-ENGINE] Captured: {$name} <{$email}> [{$id}] score=" . $lead['score'] . "\n";
        return $lead;
    }

    // ── Status ────────────────────────────────────────────────────────────────

    public static function updateStatus($id, $status) {

        if (!in_array($status, self::STATUSES)) {
            echo "[LEAD-ENGINE] Invalid status: {$status}\n";
            return false;
        }

        return self::update($id, ['status' => $status]);
    }

    // ── Scoring ───────────────────────────────────────────────────────────────

    public static function addScore($id, $points, $reason = '') {

        foreach (self::$data['leads'] as &$lead) {
            if ($lead['id'] === $id) {
                $lead['score'] += $points;
                $lead['updated'] = date('c');
                if ($reason) {
                    $lead['notes'][] = [
                        'type' => 'score',
                        'text' => "+{$points} — {$reason}",
                        'time' => date('c')
                    ];
                }
                // Auto-qualify
                if ($lead['score'] >= self::SCORE_QUALIFIED && $lead['status'] === 'new') {
                    $lead['status'] = 'contacted';
                    echo "[LEAD-ENGINE] Auto-status → contacted: {$id}\n";
                }
                self::save();
                echo "[LEAD-ENGINE] Score +{$points} → " . $lead['score'] . " ({$id})\n";
                return $lead;
            }
        }

        echo "[LEAD-ENGINE] Not found: {$id}\n";
        return false;
    }

    // ── Notes ─────────────────────────────────────────────────────────────────

    public static function addNote($id, $text, $type = 'note') {

        foreach (self::$data['leads'] as &$lead) {
            if ($lead['id'] === $id) {
                $lead['notes'][] = [
                    'type' => $type,
                    'text' => $text,
                    'time' => date('c')
                ];
                $lead['updated'] = date('c');
                self::save();
                echo "[LEAD-ENGINE] Note added to {$id}\n";
                return true;
            }
        }

        echo "[LEAD-ENGINE] Not found: {$id}\n";
        return false;
    }

    // ── Agent Assignment ──────────────────────────────────────────────────────

    public static function assignAgent($leadId, $agentId) {

        $ok = self::update($leadId, ['agent_id' => $agentId]);
        if ($ok) {
            self::addNote($leadId, "Assigned to agent: {$agentId}", 'assignment');
            echo "[LEAD-ENGINE] Agent {$agentId} → lead {$leadId}\n";
        }
        return $ok;
    }

    // ── Query ─────────────────────────────────────────────────────────────────

    public static function find($id) {
        foreach (self::$data['leads'] as $lead) {
            if ($lead['id'] === $id) return $lead;
        }
        return null;
    }

    public static function listAll() {
        return self::$data['leads'];
    }

    public static function listByStatus($status) {
        return array_values(array_filter(self::$data['leads'], fn($l) => $l['status'] === $status));
    }

    public static function listBySource($source) {
        return array_values(array_filter(self::$data['leads'], fn($l) => $l['source'] === $source));
    }

    public static function listHot() {
        return array_values(array_filter(
            self::$data['leads'],
            fn($l) => $l['score'] >= self::SCORE_HOT && $l['status'] !== 'lost'
        ));
    }

    public static function stats() {

        $leads  = self::$data['leads'];
        $counts = array_fill_keys(self::STATUSES, 0);
        $totalScore = 0;

        foreach ($leads as $lead) {
            $counts[$lead['status']] = ($counts[$lead['status']] ?? 0) + 1;
            $totalScore += $lead['score'];
        }

        $total = count($leads);

        return [
            'total'       => $total,
            'by_status'   => $counts,
            'hot'         => count(self::listHot()),
            'avg_score'   => $total > 0 ? round($totalScore / $total, 1) : 0,
            'conversion'  => $total > 0
                ? round(($counts['converted'] / $total) * 100, 1)
                : 0
        ];
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private static function initialScore($source, $interest) {
        $score = 0;
        $sourceBonus   = [ 'referral' => 20, 'agent' => 15, 'codex-temple' => 12, 'website' => 5, 'social' => 3 ];
        $interestBonus = [ 'codex-temple' => 15, 'ai-agents' => 12, 'marketplace' => 10, 'community' => 5, 'general' => 0 ];
        $score += $sourceBonus[$source]   ?? 0;
        $score += $interestBonus[$interest] ?? 0;
        return $score;
    }

    private static function update($id, $fields) {
        foreach (self::$data['leads'] as &$lead) {
            if ($lead['id'] === $id) {
                foreach ($fields as $k => $v) $lead[$k] = $v;
                $lead['updated'] = date('c');
                self::save();
                return $lead;
            }
        }
        return false;
    }

    private static function save() {
        file_put_contents(
            self::$dataFile,
            json_encode(self::$data, JSON_PRETTY_PRINT)
        );
    }
}
