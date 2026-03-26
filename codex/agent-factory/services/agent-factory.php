<?php

require_once __DIR__.'/../../../nyxa/agents/agent-registry.php';
require_once __DIR__.'/../../../nyxa/cognition/knowledge-graph.php';

class AgentFactory {

    private static $agentTypes = [
        'KnowledgeAgent',
        'TeacherAgent',
        'GuideAgent',
        'OracleAgent',
        'ArchivistAgent',
        'MediatorAgent',
        'DevAgent'
    ];

    public static function spawn($name, $type, $domain, $capabilities = [], $metadata = []) {

        if (!in_array($type, self::$agentTypes)) {
            echo "[AGENT-FACTORY] Unknown type: {$type} — defaulting to KnowledgeAgent\n";
            $type = 'KnowledgeAgent';
        }

        $id = 'agent_' . substr(md5($name . $domain . microtime()), 0, 8);

        $agent = [
            'id'              => $id,
            'name'            => $name,
            'type'            => $type,
            'domain'          => $domain,
            'status'          => 'active',
            'capabilities'    => $capabilities,
            'knowledge_nodes' => [],
            'metadata'        => $metadata,
            'created'         => date('c')
        ];

        AgentRegistry::register($agent);

        KnowledgeGraph::addNode(
            $id,
            'Agent',
            $name,
            [ 'domain' => $domain, 'type' => $type ]
        );

        echo "[AGENT-FACTORY] Spawned: {$name} [{$id}]\n";
        return $agent;
    }

    public static function activate($agentId) {
        $ok = AgentRegistry::update($agentId, [ 'status' => 'active' ]);
        if ($ok) echo "[AGENT-FACTORY] Activated: {$agentId}\n";
        return $ok;
    }

    public static function deactivate($agentId) {
        $ok = AgentRegistry::update($agentId, [ 'status' => 'inactive' ]);
        if ($ok) echo "[AGENT-FACTORY] Deactivated: {$agentId}\n";
        return $ok;
    }

    public static function assignKnowledge($agentId, $nodeId) {

        $agent = AgentRegistry::find($agentId);
        if (!$agent) {
            echo "[AGENT-FACTORY] Agent not found: {$agentId}\n";
            return false;
        }

        $nodes = $agent['knowledge_nodes'];
        if (in_array($nodeId, $nodes)) {
            echo "[AGENT-FACTORY] Node already assigned: {$nodeId}\n";
            return false;
        }

        $nodes[] = $nodeId;
        AgentRegistry::update($agentId, [ 'knowledge_nodes' => $nodes ]);

        KnowledgeGraph::addEdge($agentId, $nodeId, 'trained_on');

        echo "[AGENT-FACTORY] Knowledge assigned: {$agentId} → trained_on → {$nodeId}\n";
        return true;
    }

    public static function getAgentTypes() {
        return self::$agentTypes;
    }
}
