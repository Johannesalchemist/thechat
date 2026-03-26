<?php

/**
 * Nyxa Agent Initialization
 * Spawns all core agents, seeds the knowledge graph, links agents to knowledge.
 * Run: php init-agents.php
 */

require_once __DIR__.'/nyxa/kernel/nyxa.php';
NyxaKernel::boot();

echo "\n=== PHASE 1: Knowledge Graph — Core Concepts ===\n";

$concepts = [
    ['id' => 'nyxa_system',         'type' => 'System',  'label' => 'Nyxa System'],
    ['id' => 'knowledge_graph',     'type' => 'System',  'label' => 'Knowledge Graph'],
    ['id' => 'agent_orchestration', 'type' => 'System',  'label' => 'Agent Orchestration'],
    ['id' => 'lead_pipeline',       'type' => 'System',  'label' => 'Lead Pipeline'],
    ['id' => 'event_memory',        'type' => 'System',  'label' => 'Event Memory'],
    ['id' => 'world_model',         'type' => 'System',  'label' => 'World Model'],
    ['id' => 'consciousness',       'type' => 'Concept', 'label' => 'Consciousness'],
    ['id' => 'learning',            'type' => 'Concept', 'label' => 'Learning'],
    ['id' => 'guidance',            'type' => 'Concept', 'label' => 'Guidance'],
    ['id' => 'memory',              'type' => 'Concept', 'label' => 'Memory'],
    ['id' => 'insight',             'type' => 'Concept', 'label' => 'Insight'],
    ['id' => 'mediation',           'type' => 'Concept', 'label' => 'Mediation'],
    ['id' => 'development',         'type' => 'Concept', 'label' => 'Development'],
    ['id' => 'civilization',        'type' => 'Concept', 'label' => 'Civilization'],
    ['id' => 'johannes',            'type' => 'Person',  'label' => 'Johannes'],
    ['id' => 'the_chat',            'type' => 'Project', 'label' => 'The Chat'],
];

foreach ($concepts as $c) {
    CommandRunner::run('add_concept', $c);
}

$edges = [
    ['from' => 'nyxa_system',         'to' => 'knowledge_graph',     'type' => 'contains'],
    ['from' => 'nyxa_system',         'to' => 'agent_orchestration', 'type' => 'contains'],
    ['from' => 'nyxa_system',         'to' => 'event_memory',        'type' => 'contains'],
    ['from' => 'nyxa_system',         'to' => 'world_model',         'type' => 'contains'],
    ['from' => 'agent_orchestration', 'to' => 'lead_pipeline',       'type' => 'manages'],
    ['from' => 'johannes',            'to' => 'the_chat',            'type' => 'created'],
    ['from' => 'the_chat',            'to' => 'nyxa_system',         'type' => 'contains'],
    ['from' => 'consciousness',       'to' => 'learning',            'type' => 'enables'],
    ['from' => 'learning',            'to' => 'memory',              'type' => 'requires'],
    ['from' => 'guidance',            'to' => 'consciousness',       'type' => 'emerges_from'],
];

foreach ($edges as $e) {
    CommandRunner::run('add_knowledge_edge', $e);
}

echo "\n=== PHASE 2: Spawn Core Agents ===\n";

$agents = [
    [
        'name'         => 'Sophia',
        'agent_type'   => 'GuideAgent',
        'domain'       => 'guidance',
        'capabilities' => ['guide_user', 'conversation', 'emotional_support', 'onboard_lead', 'answer_questions'],
        'metadata'     => [
            'persona' => 'Warm, wise, and precise. Primary interface between Nyxa and the world.',
            'role'    => 'Primary Guide',
        ]
    ],
    [
        'name'         => 'Runner',
        'agent_type'   => 'MediatorAgent',
        'domain'       => 'orchestration',
        'capabilities' => ['run_flow', 'dispatch_task', 'coordinate_agents', 'agent_handoff', 'sync_world'],
        'metadata'     => ['role' => 'Flow Runner & Orchestrator']
    ],
    [
        'name'         => 'NyxaDev',
        'agent_type'   => 'DevAgent',
        'domain'       => 'development',
        'capabilities' => ['execute_command', 'spawn_agent', 'modify_graph', 'run_commandlet', 'system_check', 'debug'],
        'metadata'     => ['role' => 'Development Agent', 'service' => 'nyxa-dev-agent', 'port' => 3001]
    ],
    [
        'name'         => 'Archivist',
        'agent_type'   => 'ArchivistAgent',
        'domain'       => 'memory',
        'capabilities' => ['archive_knowledge', 'retrieve_memory', 'synthesize_history', 'knowledge_query'],
        'metadata'     => ['role' => 'Memory Keeper']
    ],
    [
        'name'         => 'Oracle',
        'agent_type'   => 'OracleAgent',
        'domain'       => 'insights',
        'capabilities' => ['predict', 'analyze', 'synthesize', 'pattern_recognition', 'knowledge_query'],
        'metadata'     => ['role' => 'Insight Engine']
    ],
    [
        'name'         => 'Mentor',
        'agent_type'   => 'TeacherAgent',
        'domain'       => 'education',
        'capabilities' => ['teach', 'explain', 'guide_learning', 'onboard_lead'],
        'metadata'     => ['role' => 'Teacher & Mentor']
    ],
    [
        'name'         => 'Codex',
        'agent_type'   => 'KnowledgeAgent',
        'domain'       => 'knowledge',
        'capabilities' => ['store_knowledge', 'retrieve_knowledge', 'knowledge_query', 'search_graph', 'add_concept'],
        'metadata'     => ['role' => 'Knowledge Keeper']
    ],
];

$spawnedAgents = [];
foreach ($agents as $agentDef) {
    $agent = CommandRunner::run('create_agent', $agentDef);
    if ($agent) {
        $spawnedAgents[$agentDef['name']] = $agent;
    }
}

echo "\n=== PHASE 3: Assign Knowledge to Agents ===\n";

$knowledgeMap = [
    'Sophia'    => ['guidance', 'consciousness', 'the_chat', 'nyxa_system'],
    'Runner'    => ['agent_orchestration', 'nyxa_system', 'event_memory'],
    'NyxaDev'   => ['development', 'nyxa_system', 'knowledge_graph', 'world_model'],
    'Archivist' => ['memory', 'knowledge_graph', 'event_memory'],
    'Oracle'    => ['insight', 'knowledge_graph', 'consciousness', 'learning'],
    'Mentor'    => ['learning', 'guidance', 'civilization'],
    'Codex'     => ['knowledge_graph', 'nyxa_system', 'civilization', 'the_chat'],
];

foreach ($knowledgeMap as $agentName => $nodes) {
    if (!isset($spawnedAgents[$agentName])) continue;
    $agentId = $spawnedAgents[$agentName]['id'];
    foreach ($nodes as $nodeId) {
        CommandRunner::run('assign_knowledge', ['agent_id' => $agentId, 'node_id' => $nodeId]);
    }
}

echo "\n=== PHASE 4: Sync World Model to Graph ===\n";
CommandRunner::run('sync_entities_to_graph', []);

echo "\n=== INITIALIZATION COMPLETE ===\n";
$stats = CommandRunner::run('agent_stats', []);
echo "Agents total:  " . ($stats['total']  ?? 0) . "\n";
echo "Agents active: " . ($stats['active'] ?? 0) . "\n";
$graphStats = CommandRunner::run('graph_stats', []);
echo "Graph nodes:   " . ($graphStats['nodes'] ?? 0) . "\n";
echo "Graph edges:   " . ($graphStats['edges'] ?? 0) . "\n";
