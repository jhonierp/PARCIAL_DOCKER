# Imagen base de Node.js
#FROM node:18-alpine
FROM node:18
# Directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar package.json (lo crearemos después)
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el código fuente
COPY . .

# Exponer el puerto 3000
EXPOSE 3000

# Comando para ejecutar la aplicación
CMD ["node", "index.js"]