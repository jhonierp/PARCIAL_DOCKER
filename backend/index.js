const express = require('express');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Configuración de la base de datos MySQL
const dbConfig = {
  host: process.env.DB_HOST || 'mysql',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'admin123',
  database: process.env.DB_NAME || 'empresa_db'
};

// Configuración de MongoDB
const mongoConfig = {
  url: process.env.MONGO_URL || 'mongodb://admin:admin123@mongodb:27017',
  dbName: process.env.MONGO_DB_NAME || 'empresa_logs',
  options: {
    authSource: 'admin'
  }
};

// Configuración del correo (Mailhog)
const mailTransporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || 'mailhog',
  port: process.env.MAIL_PORT || 1025,
  ignoreTLS: true
});

// Variables globales para conexiones
let mongoClient;
let mongoDB;

// Función para inicializar MongoDB
async function initializeMongoDB() {
  try {
    mongoClient = new MongoClient(mongoConfig.url, mongoConfig.options);
    await mongoClient.connect();
    mongoDB = mongoClient.db(mongoConfig.dbName);
    
    // Crear índice para mejorar las consultas por timestamp
    await mongoDB.collection('logs').createIndex({ timestamp: -1 });
    await mongoDB.collection('logs').createIndex({ level: 1 });
    
    console.log('✅ MongoDB conectado correctamente');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
  }
}

// Función para crear las tablas MySQL si no existen
async function initializeMySQL() {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await connection.end();
    console.log('✅ MySQL inicializado correctamente');
  } catch (error) {
    console.error('❌ Error inicializando MySQL:', error);
  }
}

// Rutas de la API

// Ruta principal
app.get('/', async (req, res) => {
  await logToMongoDB('info', 'Acceso a ruta principal', { 
    ip: req.ip, 
    userAgent: req.get('User-Agent') 
  });
  
  res.json({
    message: '🚀 API Node.js funcionando correctamente!',
    timestamp: new Date().toISOString(),
    services: {
      database: 'MySQL conectado',
      mongodb: 'MongoDB conectado para logs',
      mail: 'Mailhog configurado',
      status: 'Operativo'
    }
  });
});

// Health check
app.get('/health', async (req, res) => {
  const healthData = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      mysql: 'connected',
      mongodb: mongoDB ? 'connected' : 'disconnected',
      mailhog: 'configured'
    }
  };
  
  await logToMongoDB('info', 'Health check realizado', healthData);
  
  res.json(healthData);
});

// CRUD para usuarios

// Obtener todos los usuarios
app.get('/usuarios', async (req, res) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT * FROM usuarios ORDER BY fecha_creacion DESC');
    await connection.end();
    
    await logToMongoDB('info', 'Consulta de todos los usuarios', { 
      count: rows.length,
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    await logToMongoDB('error', 'Error obteniendo usuarios', { 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error obteniendo usuarios',
      error: error.message
    });
  }
});

// Crear un nuevo usuario
app.post('/usuarios', async (req, res) => {
  const { nombre, email } = req.body;
  
  if (!nombre || !email) {
    await logToMongoDB('warning', 'Intento de crear usuario sin datos completos', { 
      nombre, email 
    });
    
    return res.status(400).json({
      success: false,
      message: 'Nombre y email son requeridos'
    });
  }
  
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [result] = await connection.execute(
      'INSERT INTO usuarios (nombre, email) VALUES (?, ?)',
      [nombre, email]
    );
    await connection.end();
    
    const userData = {
      id: result.insertId,
      nombre,
      email
    };
    
    await logToMongoDB('info', 'Usuario creado exitosamente', userData);
    
    // Enviar email de bienvenida
    await sendWelcomeEmail(nombre, email);
    
    res.status(201).json({
      success: true,
      message: 'Usuario creado exitosamente',
      data: userData
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    await logToMongoDB('error', 'Error creando usuario', { 
      nombre, 
      email, 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error creando usuario',
      error: error.message
    });
  }
});

// Obtener un usuario específico
app.get('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT * FROM usuarios WHERE id = ?', [id]);
    await connection.end();
    
    if (rows.length === 0) {
      await logToMongoDB('warning', 'Usuario no encontrado', { userId: id });
      
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    await logToMongoDB('info', 'Consulta de usuario específico', { 
      userId: id,
      userData: rows[0]
    });
    
    res.json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    await logToMongoDB('error', 'Error obteniendo usuario', { 
      userId: id, 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error obteniendo usuario',
      error: error.message
    });
  }
});

// Actualizar un usuario
app.put('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, email } = req.body;
  
  if (!nombre || !email) {
    await logToMongoDB('warning', 'Intento de actualizar usuario sin datos completos', { 
      userId: id, nombre, email 
    });
    
    return res.status(400).json({
      success: false,
      message: 'Nombre y email son requeridos'
    });
  }
  
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [result] = await connection.execute(
      'UPDATE usuarios SET nombre = ?, email = ? WHERE id = ?',
      [nombre, email, id]
    );
    await connection.end();
    
    if (result.affectedRows === 0) {
      await logToMongoDB('warning', 'Usuario no encontrado para actualizar', { userId: id });
      
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    await logToMongoDB('info', 'Usuario actualizado exitosamente', { 
      userId: id, 
      newData: { nombre, email }
    });
    
    res.json({
      success: true,
      message: 'Usuario actualizado exitosamente',
      data: { id, nombre, email }
    });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    await logToMongoDB('error', 'Error actualizando usuario', { 
      userId: id, 
      nombre, 
      email, 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error actualizando usuario',
      error: error.message
    });
  }
});

// Eliminar un usuario
app.delete('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [result] = await connection.execute('DELETE FROM usuarios WHERE id = ?', [id]);
    await connection.end();
    
    if (result.affectedRows === 0) {
      await logToMongoDB('warning', 'Usuario no encontrado para eliminar', { userId: id });
      
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }
    
    await logToMongoDB('info', 'Usuario eliminado exitosamente', { userId: id });
    
    res.json({
      success: true,
      message: 'Usuario eliminado exitosamente'
    });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    await logToMongoDB('error', 'Error eliminando usuario', { 
      userId: id, 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error eliminando usuario',
      error: error.message
    });
  }
});

// Obtener logs desde MongoDB
app.get('/logs', async (req, res) => {
  try {
    const { level, limit = 50, page = 1 } = req.query;
    const skip = (page - 1) * limit;
    
    let filter = {};
    if (level) {
      filter.level = level;
    }
    
    const logs = await mongoDB.collection('logs')
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();
    
    const total = await mongoDB.collection('logs').countDocuments(filter);
    
    await logToMongoDB('info', 'Consulta de logs realizada', { 
      filter, 
      resultCount: logs.length,
      page,
      limit
    });
    
    res.json({
      success: true,
      data: logs,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / limit),
        total_records: total,
        records_per_page: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error obteniendo logs:', error);
    await logToMongoDB('error', 'Error obteniendo logs', { 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error obteniendo logs',
      error: error.message
    });
  }
});

// Obtener estadísticas de logs
app.get('/logs/stats', async (req, res) => {
  try {
    const stats = await mongoDB.collection('logs').aggregate([
      {
        $group: {
          _id: '$level',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]).toArray();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayLogs = await mongoDB.collection('logs').countDocuments({
      timestamp: { $gte: today }
    });
    
    const totalLogs = await mongoDB.collection('logs').countDocuments({});
    
    res.json({
      success: true,
      data: {
        by_level: stats,
        today_logs: todayLogs,
        total_logs: totalLogs,
        generated_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estadísticas',
      error: error.message
    });
  }
});

// Ruta para enviar email de prueba
app.post('/send-email', async (req, res) => {
  const { to, subject, message } = req.body;
  
  if (!to || !subject || !message) {
    return res.status(400).json({
      success: false,
      message: 'to, subject y message son requeridos'
    });
  }
  
  try {
    await mailTransporter.sendMail({
      from: 'api@empresa.com',
      to: to,
      subject: subject,
      html: `
        <h2>📧 Mensaje desde la API</h2>
        <p>${message}</p>
        <hr>
        <small>Enviado desde la API Node.js - ${new Date().toLocaleString()}</small>
      `
    });
    
    await logToMongoDB('info', 'Email enviado exitosamente', { 
      to, 
      subject,
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: 'Email enviado exitosamente'
    });
  } catch (error) {
    console.error('Error enviando email:', error);
    await logToMongoDB('error', 'Error enviando email', { 
      to, 
      subject, 
      error: error.message 
    });
    
    res.status(500).json({
      success: false,
      message: 'Error enviando email',
      error: error.message
    });
  }
});

// Funciones auxiliares

async function sendWelcomeEmail(nombre, email) {
  try {
    await mailTransporter.sendMail({
      from: 'welcome@empresa.com',
      to: email,
      subject: '¡Bienvenido a nuestra plataforma!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4CAF50;">🎉 ¡Bienvenido ${nombre}!</h2>
          <p>Gracias por registrarte en nuestra plataforma.</p>
          <p>Tu cuenta ha sido creada exitosamente con el emailsito: <strong>${email}</strong></p>
          <hr>
          <small style="color: #666;">Este es un email de prueba enviado desde Mailhog</small>
        </div>
      `
    });
    
    await logToMongoDB('info', 'Email de bienvenida enviado', { 
      nombre, 
      email,
      timestamp: new Date()
    });
    
    console.log(`✉️ Email de bienvenida enviado a ${email}`);
  } catch (error) {
    console.error('Error enviando email de bienvenida:', error);
    await logToMongoDB('error', 'Error enviando email de bienvenida', { 
      nombre, 
      email, 
      error: error.message 
    });
  }
}

// Función para guardar logs en MongoDB
async function logToMongoDB(level, message, data = {}) {
  try {
    if (!mongoDB) {
      console.warn('MongoDB no está conectado, no se puede guardar el log');
      return;
    }
    
    const logEntry = {
      level: level, // 'info', 'warning', 'error'
      message: message,
      data: data,
      timestamp: new Date(),
      service: 'nodejs-api'
    };
    
    await mongoDB.collection('logs').insertOne(logEntry);
  } catch (error) {
    console.error('Error guardando log en MongoDB:', error);
  }
}

// Inicializar la aplicación
async function startServer() {
  // Esperar un poco para que los servicios estén listos
  setTimeout(async () => {
    await initializeMongoDB();
    await initializeMySQL();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`👥 Usuarios: http://localhost:${PORT}/usuarios`);
      console.log(`📝 Logs: http://localhost:${PORT}/logs`);
      console.log(`📈 Stats de logs: http://localhost:${PORT}/logs/stats`);
      console.log(`📧 Mailhog UI: http://localhost:8025`);
      console.log(`🍃 AdminMongo: http://localhost:8082`);
      
      // Log inicial en MongoDB
      logToMongoDB('info', 'Servidor iniciado correctamente', {
        port: PORT,
        timestamp: new Date(),
        services: ['mysql', 'mongodb', 'mailhog']
      });
    });
  }, 7000); // Aumenté el tiempo de espera para MongoDB
}

// Manejar cierre graceful de la aplicación
process.on('SIGINT', async () => {
  console.log('Cerrando servidor...');
  await logToMongoDB('info', 'Servidor cerrándose', { timestamp: new Date() });
  
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});

// En tu backend (app.js o server.js)
app.use(cors({
  origin: ['http://localhost:3001', 'http://empresa_frontend:80'],
  credentials: true
}));

startServer();