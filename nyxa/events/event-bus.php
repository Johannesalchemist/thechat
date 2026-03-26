<?php

class EventBus {

    private static $listeners       = [];
    private static $memoryEnabled   = false;

    public static function init() {
        self::$listeners     = [];
        self::$memoryEnabled = false;
        echo "[EVENT-BUS] Initialized\n";
    }

    public static function enableMemory() {
        self::$memoryEnabled = true;
    }

    public static function on($event, $callback) {
        self::$listeners[$event][] = $callback;
    }

    public static function emit($event, $payload, $source = 'system') {

        // Persist to EventMemory (skip replay events to avoid loops)
        if (self::$memoryEnabled && !str_ends_with($event, '.replay')) {
            EventMemory::record($event, $payload, $source);
        }

        if (!isset(self::$listeners[$event])) {
            return;
        }

        foreach (self::$listeners[$event] as $listener) {
            $listener($payload);
        }
    }
}
