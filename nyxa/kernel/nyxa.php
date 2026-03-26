<?php

require_once __DIR__.'/../events/event-bus.php';
require_once __DIR__.'/../events/event-memory.php';
require_once __DIR__.'/../commands/command-runner.php';
require_once __DIR__.'/../world/world-model.php';
require_once __DIR__.'/../cognition/knowledge-graph.php';
require_once __DIR__.'/../cognition/graph-query.php';
require_once __DIR__.'/../agents/agent-registry.php';
require_once __DIR__.'/../../codex/agent-factory/services/agent-factory.php';
require_once __DIR__.'/../pipeline/lead-engine.php';
require_once __DIR__.'/../agents/flow-runner.php';
require_once __DIR__.'/../agents/agent-orchestrator.php';

class NyxaKernel {

    public static function boot() {

        echo "[NYXA] Booting...\n";

        EventBus::init();
        EventMemory::load();
        EventBus::enableMemory();

        CommandRunner::init();
        WorldModel::load();
        KnowledgeGraph::load();
        AgentRegistry::load();
        LeadEngine::load();
        AgentOrchestrator::init();

        echo "[NYXA] Kernel Ready\n";
    }
}
