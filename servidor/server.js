const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(__dirname));

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

  socket.on('chat_message', (data) => {
    io.emit('chat_message', data);
  });

  // Evento para procesar votos de encuestas
  socket.on('votar_encuesta', (data) => {
    io.emit('actualizar_voto', data);
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
  });
});

const PORT = 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor multijugador activo en puerto ${PORT}`);
});