// PM2 process configuration for BoozeTracker.
//
//   npm run build                 # compile server + client and assets first
//   pm2 start ecosystem.config.js # start (or reload) under PM2
//   pm2 save                      # persist the process list across reboots
//
// PM2 runs the compiled server entry point (dist/server/index.js), so make sure
// `npm run build` has been run after any source change.

module.exports = {
  apps: [
    {
      name: "boozetracker",
      script: "dist/server/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      // Keep logs alongside the project; the data/ dir is gitignored so logs
      // here won't be committed.
      error_file: "logs/boozetracker-error.log",
      out_file: "logs/boozetracker-out.log",
      merge_logs: true,
      time: true
    }
  ]
};
