<?php

require_once __DIR__.'/knowledge-graph.php';

class GraphQuery {

    public static function byType($type) {
        $nodes = KnowledgeGraph::queryByType($type);
        echo "[GRAPH-QUERY] byType({$type}) → " . count($nodes) . " nodes\n";
        return $nodes;
    }

    public static function related($nodeId, $depth = 1) {

        $visited = [];
        $result  = [];
        $queue   = [ [ 'id' => $nodeId, 'depth' => 0 ] ];

        while (!empty($queue)) {

            $item    = array_shift($queue);
            $current = $item['id'];
            $d       = $item['depth'];

            if (isset($visited[$current]) || $d > $depth) continue;
            $visited[$current] = true;

            $neighbors = KnowledgeGraph::getNeighbors($current);
            foreach ($neighbors as $neighbor) {
                if ($neighbor['node'] === null) continue;
                $result[] = [
                    'node'      => $neighbor['node'],
                    'via'       => $neighbor['edge']['type'],
                    'direction' => $neighbor['direction'],
                    'depth'     => $d + 1
                ];
                $queue[] = [ 'id' => $neighbor['node']['id'], 'depth' => $d + 1 ];
            }
        }

        echo "[GRAPH-QUERY] related({$nodeId}, depth={$depth}) → " . count($result) . " results\n";
        return $result;
    }

    public static function path($fromId, $toId) {
        $path = KnowledgeGraph::findPath($fromId, $toId);
        if ($path) {
            echo "[GRAPH-QUERY] path({$fromId} → {$toId}) = " . implode(' → ', $path) . "\n";
        } else {
            echo "[GRAPH-QUERY] path({$fromId} → {$toId}) = no path found\n";
        }
        return $path;
    }

    public static function search($term) {
        $nodes = KnowledgeGraph::search($term);
        echo "[GRAPH-QUERY] search('{$term}') → " . count($nodes) . " results\n";
        return $nodes;
    }

    public static function stats() {
        $stats = KnowledgeGraph::stats();
        echo "[GRAPH-QUERY] stats → nodes: {$stats['nodes']}, edges: {$stats['edges']}\n";
        return $stats;
    }
}
