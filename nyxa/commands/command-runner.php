<?php

class CommandRunner {

    public static function init() {
        echo "[COMMANDS] Runner Ready\n";
    }

    public static function run($command, $data) {

        echo "[CMD] Executing: $command\n";

        switch ($command) {

            // ── World Model ───────────────────────────────────────────────

            case "create_entity":
                WorldModel::createEntity($data);
                EventBus::emit("entity_created", $data);
                break;

            case "create_relationship":
                WorldModel::createRelationship($data);
                break;

            case "create_project":
                WorldModel::createEntity(array_merge($data, ["type" => "Project"]));
                EventBus::emit("project_created", $data);
                break;

            // ── Knowledge Graph ───────────────────────────────────────────

            case "add_concept":
                KnowledgeGraph::addNode(
                    $data['id'],
                    $data['type']     ?? 'Concept',
                    $data['label']    ?? $data['id'],
                    $data['metadata'] ?? []
                );
                EventBus::emit("concept_added", $data);
                break;

            case "add_knowledge_edge":
                KnowledgeGraph::addEdge(
                    $data['from'],
                    $data['to'],
                    $data['type'],
                    $data['weight'] ?? 1.0
                );
                EventBus::emit("knowledge_edge_added", $data);
                break;

            case "query_graph_by_type":
                return GraphQuery::byType($data['type']);

            case "search_graph":
                return GraphQuery::search($data['term']);

            case "graph_related":
                return GraphQuery::related($data['id'], $data['depth'] ?? 1);

            case "graph_path":
                return GraphQuery::path($data['from'], $data['to']);

            case "graph_stats":
                return GraphQuery::stats();

            case "sync_entities_to_graph":
                $entities = WorldModel::getEntities();
                foreach ($entities as $entity) {
                    $id = strtolower(str_replace(' ', '_', $entity['name']));
                    KnowledgeGraph::addNode($id, $entity['type'], $entity['name']);
                }
                $rels = WorldModel::getRelationships();
                foreach ($rels as $rel) {
                    $from = strtolower(str_replace(' ', '_', $rel['from']));
                    $to   = strtolower(str_replace(' ', '_', $rel['to']));
                    KnowledgeGraph::addEdge($from, $to, $rel['type']);
                }
                echo "[CMD] Sync complete\n";
                break;

            // ── Agent Factory ─────────────────────────────────────────────

            case "create_agent":
                $agent = AgentFactory::spawn(
                    $data['name'],
                    $data['agent_type']   ?? 'KnowledgeAgent',
                    $data['domain']       ?? 'general',
                    $data['capabilities'] ?? [],
                    $data['metadata']     ?? []
                );
                EventBus::emit("agent_created", $agent);
                return $agent;

            case "activate_agent":
                return AgentFactory::activate($data['id']);

            case "deactivate_agent":
                return AgentFactory::deactivate($data['id']);

            case "assign_knowledge":
                return AgentFactory::assignKnowledge($data['agent_id'], $data['node_id']);

            case "list_agents":
                $agents = isset($data['domain'])
                    ? AgentRegistry::listByDomain($data['domain'])
                    : AgentRegistry::listAll();
                echo "[CMD] Agents: " . count($agents) . "\n";
                return $agents;

            case "list_active_agents":
                $agents = AgentRegistry::listActive();
                echo "[CMD] Active agents: " . count($agents) . "\n";
                return $agents;

            case "agent_stats":
                return AgentRegistry::stats();

            // ── Lead Engine ───────────────────────────────────────────────

            case "capture_lead":
                $lead = LeadEngine::capture(
                    $data['name'],
                    $data['email'],
                    $data['source']   ?? 'website',
                    $data['interest'] ?? 'general',
                    $data['metadata'] ?? []
                );
                EventBus::emit("lead_captured", $lead);
                return $lead;

            case "update_lead_status":
                return LeadEngine::updateStatus($data['id'], $data['status']);

            case "score_lead":
                return LeadEngine::addScore(
                    $data['id'],
                    $data['points'],
                    $data['reason'] ?? ''
                );

            case "add_lead_note":
                return LeadEngine::addNote(
                    $data['id'],
                    $data['text'],
                    $data['type'] ?? 'note'
                );

            case "assign_agent_to_lead":
                return LeadEngine::assignAgent($data['lead_id'], $data['agent_id']);

            case "list_leads":
                if (isset($data['status'])) return LeadEngine::listByStatus($data['status']);
                if (isset($data['source'])) return LeadEngine::listBySource($data['source']);
                if (isset($data['hot']))    return LeadEngine::listHot();
                return LeadEngine::listAll();

            case "lead_stats":
                return LeadEngine::stats();

            // ── Orchestrator ──────────────────────────────────────────────

            case "run_flow":
                return AgentOrchestrator::runFlow(
                    $data['flow'],
                    $data['input'] ?? []
                );

            case "dispatch_task":
                return AgentOrchestrator::dispatch(
                    $data['task'],
                    $data['data'] ?? []
                );

            case "list_flows":
                return AgentOrchestrator::listFlows();

            case "orchestrator_stats":
                return AgentOrchestrator::stats();

            case "list_runs":
                return AgentOrchestrator::listRuns($data['limit'] ?? 20);

            case "get_run":
                return AgentOrchestrator::getRun($data['id']);

            default:
                echo "[CMD] Unknown command: $command\n";
        }
    }
}
