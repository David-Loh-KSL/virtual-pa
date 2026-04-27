# Virtual PA — Deployment Guide

## What's in this project

```
vpa-app/
├── src/
│   ├── App.jsx          ← Main React app
│   ├── notion.js        ← Notion API service
│   ├── main.jsx         ← React entry point
│   └── index.css        ← Global styles
├── netlify/
│   └── functions/
│       └── notion.js    ← Serverless proxy (Netlify)
├── server.js            ← Express proxy (Coolify)
├── Dockerfile           ← For Coolify deployment
├── netlify.toml         ← Netlify configuration
├── vite.config.js       ← Vite configuration
├── package.json         ← Dependencies
└── index.html           ← HTML entry point
```

---

## Your Configuration Values

```
check my private note
```

---

## Option A — Netlify (Recommended, accessible anywhere)

### Prerequisites
- Node.js installed
- Free Netlify account (netlify.com)
- Netlify CLI: `npm install -g netlify-cli`

### Steps

1. **Install dependencies**
   ```
   cd vpa-app
   npm install
   ```

2. **Create environment file**
   ```
   cp .env.example .env.local
   ```
   Edit `.env.local` and fill in your values.

3. **Test locally**
   ```
   netlify dev
   ```
   Open http://localhost:8888

4. **Deploy to Netlify**
   ```
   netlify login
   netlify init
   netlify deploy --prod
   ```

5. **Set environment variables in Netlify**
   - Go to Netlify dashboard → Your site → Site configuration → Environment variables
   - Add:
     - `NOTION_TOKEN` = your token
     - `VITE_TASKS_DB_ID` = your tasks DB ID
     - `VITE_KB_DB_ID` = your KB DB ID
   - Redeploy after adding variables

6. **Your app is live** at `https://your-site-name.netlify.app`

---

## Option B — Coolify (Internal, VPN access)

### Prerequisites
- Access to your Coolify instance
- Docker support enabled

### Steps

1. **Push to a Git repository** (GitHub, GitLab, or Gitea)
   ```
   git init
   git add .
   git commit -m "Virtual PA v1"
   git remote add origin YOUR_REPO_URL
   git push -u origin main
   ```

2. **In Coolify**
   - Create new Resource → Docker Compose / Dockerfile
   - Connect your Git repository
   - Set environment variables:
     - `NOTION_TOKEN` = your token
     - `VITE_TASKS_DB_ID` = your tasks DB ID
     - `VITE_KB_DB_ID` = your KB DB ID
     - `PORT` = 3001
   - Deploy

3. **Access via your internal URL** (VPN required)

---

## Local Development (No deployment)

1. Install dependencies: `npm install`
2. Copy env file: `cp .env.example .env.local` and fill in values
3. Start dev server: `npm run dev`
4. Open http://localhost:5173

Note: In local dev, Notion API calls are proxied through Vite's dev server
to avoid CORS issues.

---

## Troubleshooting

**"Could not connect to Notion"**
- Check NOTION_TOKEN is correct
- Check both DB IDs are correct
- Make sure both databases are connected to your Virtual PA integration in Notion

**"Name is not a property that exists"**
- The Notion DB title column may have a different name
- Open the DB in Notion and check the column name

**Tasks not showing**
- Check the DB IDs match your actual Notion databases
- Make sure the integration has access to both databases (Content access tab)
