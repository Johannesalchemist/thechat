<?php

class KnowledgeGraph {

    private static $graph;
    private static $dataFile;

    public static function load() {

        self::$dataFile = __DIR__.'/../../data/knowledge-graph/graph.json';

        if (!file_exists(self::$dataFile)) {
            self::$graph = [ "nodes" => [], "edges" => [] ];
            self::save();
        }

        self::$graph = json_decode(file_get_contents(self::$dataFile), true);
        $nodes = count(self::$graph['nodes']);
        $edges = count(self::$graph['edges']);
        echo "[KNOWLEDGE-GRAPH] Loaded — {$nodes} nodes, {$edges} edges\n";
    }

    public static function addNode($id, $type, $label, $metadata = []) {

        foreach (self::$graph['nodes'] as $node) {
            if ($node['id'] === $id) {
                echo "[KNOWLEDGE-GRAPH] Node exists: {$id}\n";
                return;
            }
        }

        self::$graph['nodes'][] = [
            'id'        => $id,
            'type'      => $type,
            'label'     => $label,
            'metadata'  => $metadata,
            'created'   => date('c')
        ];

        self::save();
        echo "[KNOWLEDGE-GRAPH] Node added: {$label} ({$type})\n";
    }

    public static function addEdge($fromId, $toId, $type, $weight = 1.0) {

        foreach (self::$graph['edges'] as $edge) {
            if ($edge['from'] === $fromId && $edge['to'] === $toId && $edge['type'] === $type) {
                echo "[KNOWLEDGE-GRAPH] Edge exists: {$fromId} → {$type} → {$toId}\n";
                return;
            }
        }

        self::$graph['edges'][] = [
            'from'    => $fromId,
            'to'      => $toId,
            'type'    => $type,
            'weight'  => $weight,
            'created' => date('c')
        ];

        self::save();
        echo "[KNOWLEDGE-GRAPH] Edge: {$fromId} → {$type} → {$toId}\n";
    }

    public static function getNode($id) {
        foreach (self::$graph['nodes'] as $node) {
            if ($node['id'] === $id) return $node;
        }
        return null;
    }

    public static function getNeighbors($nodeId, $direction = 'both') {

        $neighbors = [];

        foreach (self::$graph['edges'] as $edge) {
            if ($direction !== 'in' && $edge['from'] === $nodeId) {
                $neighbors[] = [ 'node' => self::getNode($edge['to']), 'edge' => $edge, 'direction' => 'out' ];
            }
            if ($direction !== 'out' && $edge['to'] === $nodeId) {
                $neighbors[] = [ 'node' => self::getNode($edge['from']), 'edge' => $edge, 'direction' => 'in' ];
            }
        }

        return $neighbors;
    }

    public static function findPath($fromId, $toId) {

        if ($fromId === $toId) return [ $fromId ];

        $visited = [ $fromId => true ];
        $queue   = [ [ $fromId ] ];

        while (!empty($queue)) {

            $path    = array_shift($queue);
            $current = end($path);

            foreach (self::$graph['edges'] as $edge) {

                $next = null;
                if ($edge['from'] === $current) $next = $edge['to'];
                if ($edge['to']   === $current) $next = $edge['from'];

                if ($next === null || isset($visited[$next])) continue;

                $newPath = array_merge($path, [ $next ]);

                if ($next === $toId) return $newPath;

                $visited[$next] = true;
                $queue[] = $newPath;
            }
        }

        return null;
    }

    public static function queryByType($type) {
        return array_values(array_filter(self::$graph['nodes'], fn($n) => $n['type'] === $type));
    }

    public static function search($term) {
        $term = strtolower($term);
        return array_values(array_filter(self::$graph['nodes'], function($n) use ($term) {
            return str_contains(strtolower($n['label']), $term)
                || str_contains(strtolower($n['id']), $term);
        }));
    }

    public static function stats() {
        $types = [];
        foreach (self::$graph['nodes'] as $node) {
            $types[$node['type']] = ($types[$node['type']] ?? 0) + 1;
        }
        return [
            'nodes'      => count(self::$graph['nodes']),
            'edges'      => count(self::$graph['edges']),
            'node_types' => $types
        ];
    }

    public static function getAll() {
        return self::$graph;
    }

    private static function save() {
        file_put_contents(
            self::$dataFile,
            json_encode(self::$graph, JSON_PRETTY_PRINT)
        );
    }
}
