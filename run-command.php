<?php

/**
 * Nyxa CLI Commandlet Runner
 * Usage: php run-command.php <command> [json_data]
 * Example: php run-command.php create_agent '{name:Sophia,agent_type:GuideAgent,domain:guidance}'
 */

 = [1] ?? null;
 = [2] ?? '{}';

if (!) {
    echo json_encode(['ok' => false, 'error' => 'No command provided']);
    exit(1);
}

 = json_decode(, true);
if ( === null &&  !== '{}') {
    echo json_encode(['ok' => false, 'error' => 'Invalid JSON data']);
    exit(1);
}

require_once __DIR__.'/nyxa/kernel/nyxa.php';
NyxaKernel::boot();

 = CommandRunner::run(,  ?? []);

echo json_encode([
    'ok'      => true,
    'command' => ,
    'result'  => 
]);
