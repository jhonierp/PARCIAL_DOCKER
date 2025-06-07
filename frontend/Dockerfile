# frontend/Dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Variables de entorno para el build
ARG REACT_APP_API_URL=http://nodejs_api:3000
ENV REACT_APP_API_URL=$REACT_APP_API_URL

RUN npm run build

# Servir con serve (más simple que nginx interno)
RUN npm install -g serve
EXPOSE 3000
CMD ["serve", "-s", "build", "-l", "3000", "--no-clipboard"]