// pm2 process definitions for the production box.
//
// Tracked in git deliberately: this and deploy.sh used to exist only on the
// EC2 instance, so the whole deployment — which services run, from where, how
// web is started — was one lost instance away from having to be reconstructed
// from memory. No secrets belong here; every service reads its own .env from
// `cwd`, which stays untracked.
module.exports = {
  apps: [
    {
      name: 'content-api',
      cwd: '/home/ubuntu/MultiAgentBrandingSystem/apps/content-api',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'content-worker',
      cwd: '/home/ubuntu/MultiAgentBrandingSystem/apps/content-worker',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'geo-api',
      cwd: '/home/ubuntu/MultiAgentBrandingSystem/apps/geo-api',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'geo-worker',
      cwd: '/home/ubuntu/MultiAgentBrandingSystem/apps/geo-worker',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
    {
      // `next start` rather than a dist entrypoint, so `interpreter: 'none'`
      // — pm2 would otherwise run the bin through node twice.
      name: 'web',
      cwd: '/home/ubuntu/MultiAgentBrandingSystem/apps/web',
      script: 'node_modules/.bin/next',
      args: 'start -p 3000',
      interpreter: 'none',
      env: { NODE_ENV: 'production' },
    },
  ],
};
