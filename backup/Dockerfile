FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build React app
RUN npm run build

# Install server dependencies
RUN npm install express http-proxy-middleware

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]
