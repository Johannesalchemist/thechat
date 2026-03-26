<?php

require_once "kernel/nyxa.php";

NyxaKernel::boot();

// Initiale Weltstruktur
CommandRunner::run("create_entity", [
    "type" => "Person",
    "name" => "Johannes",
    "role" => "creator"
]);

CommandRunner::run("create_entity", [
    "type" => "Project",
    "name" => "The Chat",
    "status" => "active"
]);

CommandRunner::run("create_entity", [
    "type" => "Idea",
    "name" => "Nyxa Civilization"
]);

CommandRunner::run("create_relationship", [
    "from" => "Johannes",
    "type" => "creates",
    "to"   => "The Chat"
]);

CommandRunner::run("create_relationship", [
    "from" => "The Chat",
    "type" => "contains",
    "to"   => "Nyxa Civilization"
]);

echo "\n[NYXA] Boot complete. World Model initialized.\n";
echo "[NYXA] Entities: " . count(WorldModel::getEntities()) . "\n";
echo "[NYXA] Relations: " . count(WorldModel::getRelationships()) . "\n";
