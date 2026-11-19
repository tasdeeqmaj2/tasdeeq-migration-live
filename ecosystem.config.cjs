/**
 * PM2 process file for Ubuntu server.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs --only migrate-fresh
 *   pm2 start ecosystem.config.cjs --only migrate-assets
 *   pm2 logs
 *   pm2 status
 *
 * migrate-fresh / migrate are one-shot (autorestart: false).
 * migrate-assets is long-running and safe to resume if it exits.
 */
module.exports = {
  apps: [
    {
      name: 'restore-dump',
      cwd: __dirname,
      script: 'restoreDump.sh',
      interpreter: 'bash',
      // Set DUMP_FILE when starting, e.g.:
      // DUMP_FILE=/root/dump-tasdeeq-202607241017.sql pm2 start ecosystem.config.cjs --only restore-dump
      env: {
        DUMP_FILE: process.env.DUMP_FILE || '',
        POSTGRES_CONTAINER: process.env.POSTGRES_CONTAINER || 'tasdeeq-postgres-1',
        POSTGRES_USER: process.env.POSTGRES_USER || 'tasdeeq',
        POSTGRES_DB_LIVE: process.env.POSTGRES_DB_LIVE || 'tasdeeq_live',
      },
      autorestart: false,
      watch: false,
      error_file: 'logs/pm2-restore-dump-error.log',
      out_file: 'logs/pm2-restore-dump-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'migrate-fresh',
      cwd: __dirname,
      script: 'index.js',
      args: ['--fresh'],
      interpreter: 'node',
      autorestart: false,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-migrate-fresh-error.log',
      out_file: 'logs/pm2-migrate-fresh-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'migrate',
      cwd: __dirname,
      script: 'index.js',
      interpreter: 'node',
      autorestart: false,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-migrate-error.log',
      out_file: 'logs/pm2-migrate-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'migrate-assets',
      cwd: __dirname,
      script: 'migrateAssets.js',
      interpreter: 'node',
      autorestart: false,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-migrate-assets-error.log',
      out_file: 'logs/pm2-migrate-assets-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
