// PM2 process definition for the Time Champ backend.
//   pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'rxchamp-api',
      script: 'dist/main.js',
      // cwd must be the project root: main.ts registers module-alias, which
      // resolves @shared/@modules from package.json's _moduleAliases, and
      // ConfigModule reads `.env` relative to the working directory.
      cwd: '/opt/rxchamp',

      // FORK MODE, SINGLE INSTANCE — deliberate, do not switch to cluster.
      //
      // This app has five Socket.IO gateways (activity, chat, notifications,
      // presence, screenshots) and no Redis adapter. Under `exec_mode:
      // 'cluster'` with instances > 1:
      //   1. HTTP long-polling handshakes round-robin across workers, so the
      //      follow-up request lands on a worker that has never seen the
      //      session -> "Session ID unknown" and endless reconnects.
      //   2. server.emit() only reaches sockets held by the emitting worker,
      //      so broadcasts silently reach a fraction of connected agents.
      // Scaling out requires @socket.io/redis-adapter plus sticky sessions
      // first. Until then this stays at one process.
      instances: 1,
      exec_mode: 'fork',

      // Env lives in /opt/rxchamp/.env and is read by ConfigModule; PM2 only
      // needs NODE_ENV set early enough for Nest's own production behaviour.
      env: {
        NODE_ENV: 'production',
      },

      // Restart on crash, but stop flapping if it fails to boot (e.g. bad
      // DATABASE_URL) instead of hammering RDS with connection attempts.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 4000,

      // The 4 GB instance also runs nginx; recycle if the process leaks.
      max_memory_restart: '1G',

      error_file: '/var/log/rxchamp/error.log',
      out_file: '/var/log/rxchamp/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
