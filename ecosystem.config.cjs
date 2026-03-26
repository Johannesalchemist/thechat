module.exports = {
  apps: [
    {
      name: 'nyxa-api',
      script: 'apps/console/api/server.js',
      cwd: '/opt/thechat',
      env_file: '/opt/thechat/.env',
      env: { OPENROUTER_API_KEY: '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' },
      restart_delay: 3000,
      max_restarts: 10
    },
    {
      name: 'nyxa-bot',
      script: 'apps/telegram/bot.js',
      cwd: '/opt/thechat',
      env_file: '/opt/thechat/.env',
      env: { OPENROUTER_API_KEY: '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' },
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'nyxa-dev-agent',
      script: 'apps/dev-agent/index.js',
      cwd: '/opt/thechat',
      env_file: '/opt/thechat/.env',
      env: { OPENROUTER_API_KEY: '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' },
      restart_delay: 3000,
      max_restarts: 10
    }
  ]
}
