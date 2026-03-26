<?php

class WorldModel {

    private static $world;
    private static $dataFile;

    public static function load() {

        self::$dataFile = __DIR__.'/../data/world.json';

        if (!file_exists(self::$dataFile)) {
            self::$world = [
                "entities"      => [],
                "relationships" => [],
                "events"        => [],
                "goals"         => []
            ];
            self::save();
        }

        self::$world = json_decode(file_get_contents(self::$dataFile), true);
        $count = count(self::$world["entities"]);
        echo "[WORLD] Model loaded — {$count} entities\n";
    }

    public static function createEntity($entity) {
        self::$world["entities"][] = $entity;
        self::save();
        echo "[WORLD] Entity created: " . ($entity["name"] ?? "unknown") . "\n";
    }

    public static function createRelationship($rel) {
        self::$world["relationships"][] = $rel;
        self::save();
        echo "[WORLD] Relationship: " . $rel["from"] . " → " . $rel["type"] . " → " . $rel["to"] . "\n";
    }

    public static function getEntities() {
        return self::$world["entities"] ?? [];
    }

    public static function getRelationships() {
        return self::$world["relationships"] ?? [];
    }

    private static function save() {
        file_put_contents(
            self::$dataFile,
            json_encode(self::$world, JSON_PRETTY_PRINT)
        );
    }
}
