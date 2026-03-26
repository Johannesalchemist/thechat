<?php

class AgentRegistry {

    private static $data;
    private static $dataFile;

    public static function load() {

        self::$dataFile = __DIR__.'/../../codex/agent-factory/storage/agents.json';

        if (!file_exists(self::$dataFile)) {
            self::$data = [ "agents" => [] ];
            self::save();
        }

        self::$data = json_decode(file_get_contents(self::$dataFile), true);
        $count = count(self::$data['agents']);
        echo "[AGENT-REGISTRY] Loaded — {$count} agents\n";
    }

    public static function register($agent) {

        foreach (self::$data['agents'] as $existing) {
            if ($existing['id'] === $agent['id']) {
                echo "[AGENT-REGISTRY] Agent exists: {$agent['id']}\n";
                return;
            }
        }

        self::$data['agents'][] = $agent;
        self::save();
        echo "[AGENT-REGISTRY] Registered: {$agent['name']} ({$agent['type']})\n";
    }

    public static function find($id) {
        foreach (self::$data['agents'] as $agent) {
            if ($agent['id'] === $id) return $agent;
        }
        return null;
    }

    public static function update($id, $fields) {
        foreach (self::$data['agents'] as &$agent) {
            if ($agent['id'] === $id) {
                foreach ($fields as $key => $value) {
                    $agent[$key] = $value;
                }
                self::save();
                echo "[AGENT-REGISTRY] Updated: {$id}\n";
                return true;
            }
        }
        echo "[AGENT-REGISTRY] Not found: {$id}\n";
        return false;
    }

    public static function listAll() {
        return self::$data['agents'];
    }

    public static function listActive() {
        return array_values(array_filter(self::$data['agents'], fn($a) => $a['status'] === 'active'));
    }

    public static function listByDomain($domain) {
        return array_values(array_filter(self::$data['agents'], fn($a) => $a['domain'] === $domain));
    }

    public static function stats() {
        $all    = self::$data['agents'];
        $active = array_filter($all, fn($a) => $a['status'] === 'active');
        $types  = [];
        foreach ($all as $agent) {
            $types[$agent['type']] = ($types[$agent['type']] ?? 0) + 1;
        }
        return [
            'total'  => count($all),
            'active' => count($active),
            'types'  => $types
        ];
    }

    private static function save() {
        file_put_contents(
            self::$dataFile,
            json_encode(self::$data, JSON_PRETTY_PRINT)
        );
    }
}
