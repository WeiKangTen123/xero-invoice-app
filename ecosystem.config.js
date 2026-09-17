// pm2 process definition, committed so the restart policy is not a setting
// that lives only in one server's pm2 dump. Backoff stops a crash loop from
// restarting hundreds of times a minute; max_restarts stops it entirely
// until someone looks (the fatal handlers in main/index.js post the reason
// to Slack first). deploy.sh runs `pm2 startOrReload` on this file.
module.exports = {
  apps: [{
    name:       'xero-invoice-app',
    script:     'main/index.js',
    cwd:        __dirname,
    exec_mode:  'fork',
    instances:  1,
    exp_backoff_restart_delay: 1000,
    max_restarts: 10,
    min_uptime:   '10s',
    kill_timeout: 8000,
    env: { NODE_ENV: 'production' },
  }],
};
