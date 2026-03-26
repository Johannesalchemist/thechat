<?php

class AgentOrchestrator {

    private static $flows    = [];
    private static $runs     = [];
    private static $runsFile;

    public static function init() {

        self::$runsFile = __DIR__.'/../../data/orchestrator/runs.json';

        if (!file_exists(self::$runsFile)) {
            @mkdir(dirname(self::$runsFile), 0755, true);
            file_put_contents(self::$runsFile, json_encode(["runs" => []], JSON_PRETTY_PRINT));
        }

        self::$runs = json_decode(file_get_contents(self::$runsFile), true);

        // Register built-in flows
        self::registerBuiltinFlows();

        echo "[ORCHESTRATOR] Ready — " . count(self::$flows) . " flows registered\n";
    }

    // ── Flow Registration ─────────────────────────────────────────────────────

    public static function defineFlow($name, $steps, $description = '') {
        self::$flows[$name] = [
            'name'        => $name,
            'description' => $description,
            'steps'       => $steps,
        ];
        echo "[ORCHESTRATOR] Flow registered: {$name} (" . count($steps) . " steps)\n";
    }

    public static function getFlow($name) {
        return self::$flows[$name] ?? null;
    }

    public static function listFlows() {
        return array_values(array_map(function($f) {
            return [
                'name'        => $f['name'],
                'description' => $f['description'],
                'steps'       => count($f['steps']),
            ];
        }, self::$flows));
    }

    // ── Task Dispatch ─────────────────────────────────────────────────────────

    public static function dispatch($task, $data = []) {

        echo "[ORCHESTRATOR] Dispatch: {$task}\n";

        // Find best agent for task by domain/capability match
        $agents = AgentRegistry::listActive();
        $best   = null;

        foreach ($agents as $agent) {
            if (in_array($task, $agent['capabilities'] ?? [])) {
                $best = $agent;
                break;
            }
        }

        // Fallback: match by domain
        if (!$best) {
            $domain = $data['domain'] ?? 'general';
            $byDomain = AgentRegistry::listByDomain($domain);
            $best = !empty($byDomain) ? $byDomain[0] : null;
        }

        // Fallback: first active agent
        if (!$best && !empty($agents)) {
            $best = $agents[0];
        }

        if (!$best) {
            echo "[ORCHESTRATOR] No agent available for: {$task}\n";
            return ['status' => 'no_agent', 'task' => $task];
        }

        echo "[ORCHESTRATOR] Dispatched to: {$best['name']} [{$best['id']}]\n";
        EventBus::emit('task_dispatched', ['task' => $task, 'agent' => $best['id'], 'data' => $data]);

        return ['status' => 'dispatched', 'agent' => $best, 'task' => $task, 'data' => $data];
    }

    // ── Flow Execution ────────────────────────────────────────────────────────

    public static function runFlow($flowName, $input = []) {

        $flow = self::$flows[$flowName] ?? null;

        if (!$flow) {
            echo "[ORCHESTRATOR] Unknown flow: {$flowName}\n";
            return ['status' => 'error', 'error' => "Flow not found: {$flowName}"];
        }

        $runId = 'run_' . substr(md5($flowName . microtime()), 0, 8);

        $run = [
            'id'        => $runId,
            'flow'      => $flowName,
            'input'     => $input,
            'status'    => 'running',
            'steps'     => [],
            'output'    => null,
            'started'   => date('c'),
            'finished'  => null,
        ];

        echo "[ORCHESTRATOR] Flow start: {$flowName} [{$runId}]\n";
        EventBus::emit('flow_started', ['run_id' => $runId, 'flow' => $flowName]);

        $context = $input;

        foreach ($flow['steps'] as $i => $step) {

            $stepResult = FlowRunner::executeStep($step, $context, $i + 1);

            $run['steps'][] = $stepResult;

            if ($stepResult['status'] === 'error') {
                $run['status']   = 'failed';
                $run['finished'] = date('c');
                self::saveRun($run);
                echo "[ORCHESTRATOR] Flow failed at step " . ($i + 1) . ": {$flowName}\n";
                EventBus::emit('flow_failed', ['run_id' => $runId, 'step' => $i + 1]);
                return $run;
            }

            // Merge step output into context for next step
            if (!empty($stepResult['output']) && is_array($stepResult['output'])) {
                $context = array_merge($context, $stepResult['output']);
            }
        }

        $run['status']   = 'completed';
        $run['output']   = $context;
        $run['finished'] = date('c');

        self::saveRun($run);

        echo "[ORCHESTRATOR] Flow complete: {$flowName} [{$runId}]\n";
        EventBus::emit('flow_completed', ['run_id' => $runId, 'flow' => $flowName]);

        return $run;
    }

    // ── Run History ───────────────────────────────────────────────────────────

    public static function getRun($runId) {
        foreach (self::$runs['runs'] as $run) {
            if ($run['id'] === $runId) return $run;
        }
        return null;
    }

    public static function listRuns($limit = 20) {
        return array_slice(array_reverse(self::$runs['runs']), 0, $limit);
    }

    public static function stats() {
        $runs      = self::$runs['runs'];
        $completed = count(array_filter($runs, fn($r) => $r['status'] === 'completed'));
        $failed    = count(array_filter($runs, fn($r) => $r['status'] === 'failed'));
        return [
            'flows'     => count(self::$flows),
            'runs'      => count($runs),
            'completed' => $completed,
            'failed'    => $failed,
        ];
    }

    // ── Built-in Flows ────────────────────────────────────────────────────────

    private static function registerBuiltinFlows() {

        self::defineFlow('onboard_lead', [
            ['type' => 'command', 'command' => 'capture_lead',   'map' => ['name' => 'name', 'email' => 'email', 'source' => 'source', 'interest' => 'interest']],
            ['type' => 'command', 'command' => 'score_lead',     'map' => ['id' => 'id', 'points' => 'score_bonus', 'reason' => 'reason']],
            ['type' => 'dispatch', 'task'   => 'welcome',        'map' => ['domain' => 'interest']],
        ], 'Capture, score and welcome a new lead');

        self::defineFlow('knowledge_query', [
            ['type' => 'command', 'command' => 'search_graph',   'map' => ['term' => 'query']],
            ['type' => 'dispatch', 'task'   => 'answer',         'map' => ['domain' => 'domain']],
        ], 'Search knowledge graph and dispatch to relevant agent');

        self::defineFlow('agent_handoff', [
            ['type' => 'command', 'command' => 'deactivate_agent', 'map' => ['id' => 'from_agent']],
            ['type' => 'command', 'command' => 'activate_agent',   'map' => ['id' => 'to_agent']],
            ['type' => 'dispatch', 'task'   => 'continue',         'map' => []],
        ], 'Hand off conversation from one agent to another');

        self::defineFlow('sync_world', [
            ['type' => 'command', 'command' => 'sync_entities_to_graph', 'map' => []],
            ['type' => 'command', 'command' => 'graph_stats',            'map' => []],
        ], 'Sync world model entities into knowledge graph');
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private static function saveRun($run) {
        // Keep last 200 runs
        self::$runs['runs'][] = $run;
        if (count(self::$runs['runs']) > 200) {
            self::$runs['runs'] = array_slice(self::$runs['runs'], -200);
        }
        file_put_contents(
            self::$runsFile,
            json_encode(self::$runs, JSON_PRETTY_PRINT)
        );
    }
}
