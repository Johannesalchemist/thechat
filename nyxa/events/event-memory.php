<?php

class EventMemory {

    private static $data;
    private static $dataFile;

    // Max events retained in memory (ring buffer)
    const MAX_EVENTS = 10000;

    public static function load() {

        self::$dataFile = __DIR__.'/../../data/events/events.json';

        if (!file_exists(self::$dataFile)) {
            self::$data = [ "events" => [] ];
            self::save();
        }

        self::$data = json_decode(file_get_contents(self::$dataFile), true);
        $count = count(self::$data['events']);
        echo "[EVENT-MEMORY] Loaded — {$count} events\n";
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    public static function record($type, $payload, $source = 'system') {

        $event = [
            'id'        => 'evt_' . substr(md5($type . microtime()), 0, 8),
            'type'      => $type,
            'payload'   => $payload,
            'source'    => $source,
            'timestamp' => date('c'),
            'ts'        => time(),
        ];

        self::$data['events'][] = $event;

        // Ring buffer — trim oldest if over limit
        if (count(self::$data['events']) > self::MAX_EVENTS) {
            self::$data['events'] = array_slice(self::$data['events'], -self::MAX_EVENTS);
        }

        self::save();
        return $event;
    }

    // ── Query ─────────────────────────────────────────────────────────────────

    public static function getAll($limit = 100, $offset = 0) {
        $events = array_reverse(self::$data['events']); // newest first
        return array_slice($events, $offset, $limit);
    }

    public static function byType($type, $limit = 50) {
        $filtered = array_filter(self::$data['events'], fn($e) => $e['type'] === $type);
        return array_slice(array_reverse(array_values($filtered)), 0, $limit);
    }

    public static function since($timestamp, $limit = 100) {
        $ts       = is_string($timestamp) ? strtotime($timestamp) : $timestamp;
        $filtered = array_filter(self::$data['events'], fn($e) => $e['ts'] >= $ts);
        return array_slice(array_values($filtered), 0, $limit);
    }

    public static function last($n = 10) {
        $events = self::$data['events'];
        return array_slice(array_reverse($events), 0, $n);
    }

    public static function search($term, $limit = 50) {
        $term     = strtolower($term);
        $filtered = array_filter(self::$data['events'], function($e) use ($term) {
            return str_contains(strtolower($e['type']), $term)
                || str_contains(strtolower(json_encode($e['payload'])), $term);
        });
        return array_slice(array_reverse(array_values($filtered)), 0, $limit);
    }

    public static function stats() {
        $events = self::$data['events'];
        $types  = [];

        foreach ($events as $e) {
            $types[$e['type']] = ($types[$e['type']] ?? 0) + 1;
        }

        arsort($types);

        $oldest = !empty($events) ? $events[0]['timestamp'] : null;
        $newest = !empty($events) ? end($events)['timestamp'] : null;

        return [
            'total'      => count($events),
            'by_type'    => $types,
            'oldest'     => $oldest,
            'newest'     => $newest,
        ];
    }

    public static function replay($type = null) {
        $events = $type ? self::byType($type, self::MAX_EVENTS) : self::$data['events'];
        echo "[EVENT-MEMORY] Replaying " . count($events) . " events\n";

        foreach (array_reverse($events) as $event) {
            EventBus::emit($event['type'] . '.replay', $event['payload']);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private static function save() {
        file_put_contents(
            self::$dataFile,
            json_encode(self::$data, JSON_PRETTY_PRINT)
        );
    }
}
