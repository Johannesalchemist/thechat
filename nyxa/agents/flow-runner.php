<?php

class FlowRunner {

    public static function executeStep($step, $context, $stepNum) {

        $type = $step['type'] ?? 'command';

        echo "[FLOW-RUNNER] Step {$stepNum}: {$type}\n";

        try {
            switch ($type) {

                case 'command':
                    return self::runCommand($step, $context, $stepNum);

                case 'dispatch':
                    return self::runDispatch($step, $context, $stepNum);

                case 'condition':
                    return self::runCondition($step, $context, $stepNum);

                case 'log':
                    return self::runLog($step, $context, $stepNum);

                default:
                    return self::error($stepNum, "Unknown step type: {$type}");
            }
        } catch (Exception $e) {
            return self::error($stepNum, $e->getMessage());
        }
    }

    // ── Command Step ──────────────────────────────────────────────────────────

    private static function runCommand($step, $context, $stepNum) {

        $command = $step['command'] ?? null;
        if (!$command) return self::error($stepNum, 'No command specified');

        // Map context fields to command data
        $data = self::mapFields($step['map'] ?? [], $context);

        $result = CommandRunner::run($command, $data);

        $output = is_array($result) ? $result : ['result' => $result];

        echo "[FLOW-RUNNER] Step {$stepNum} OK: {$command}\n";

        return [
            'step'    => $stepNum,
            'type'    => 'command',
            'command' => $command,
            'status'  => 'ok',
            'output'  => $output,
        ];
    }

    // ── Dispatch Step ─────────────────────────────────────────────────────────

    private static function runDispatch($step, $context, $stepNum) {

        $task = $step['task'] ?? 'general';
        $data = self::mapFields($step['map'] ?? [], $context);

        $result = AgentOrchestrator::dispatch($task, $data);

        echo "[FLOW-RUNNER] Step {$stepNum} OK: dispatch:{$task}\n";

        return [
            'step'   => $stepNum,
            'type'   => 'dispatch',
            'task'   => $task,
            'status' => 'ok',
            'output' => $result,
        ];
    }

    // ── Condition Step ────────────────────────────────────────────────────────

    private static function runCondition($step, $context, $stepNum) {

        $field    = $step['field']    ?? null;
        $operator = $step['operator'] ?? 'exists';
        $value    = $step['value']    ?? null;

        $fieldValue = $context[$field] ?? null;

        $pass = match($operator) {
            'exists'   => $fieldValue !== null,
            'equals'   => $fieldValue === $value,
            'gt'       => is_numeric($fieldValue) && $fieldValue > $value,
            'lt'       => is_numeric($fieldValue) && $fieldValue < $value,
            'contains' => is_string($fieldValue) && str_contains($fieldValue, $value),
            default    => false
        };

        echo "[FLOW-RUNNER] Step {$stepNum} condition [{$field} {$operator}]: " . ($pass ? 'PASS' : 'SKIP') . "\n";

        return [
            'step'   => $stepNum,
            'type'   => 'condition',
            'status' => $pass ? 'ok' : 'skipped',
            'output' => [],
        ];
    }

    // ── Log Step ──────────────────────────────────────────────────────────────

    private static function runLog($step, $context, $stepNum) {
        $message = $step['message'] ?? 'Flow step';
        echo "[FLOW-RUNNER] LOG: {$message}\n";
        EventBus::emit('flow_log', ['step' => $stepNum, 'message' => $message, 'context' => $context]);
        return ['step' => $stepNum, 'type' => 'log', 'status' => 'ok', 'output' => []];
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static function mapFields($map, $context) {
        if (empty($map)) return $context;
        $data = [];
        foreach ($map as $target => $source) {
            $data[$target] = $context[$source] ?? null;
        }
        return $data;
    }

    private static function error($stepNum, $message) {
        echo "[FLOW-RUNNER] Step {$stepNum} ERROR: {$message}\n";
        return ['step' => $stepNum, 'status' => 'error', 'error' => $message, 'output' => []];
    }
}
