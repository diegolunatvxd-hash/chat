const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(__dirname));

// Historial en memoria por cada sala (se borra si se reinicia el servidor)
const historialSalas = {};

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

  // Unirse a una sala (Pública o Privada)
  socket.on('unirse_sala', (sala) => {
    // Salir de salas anteriores
    if (socket.salaActual) {
      socket.leave(socket.salaActual);
    }

    socket.salaActual = sala;
    socket.join(sala);

    // Si la sala no existe en el historial, se crea
    if (!historialSalas[sala]) {
      historialSalas[sala] = [];
    }

    // Enviar mensajes anteriores al usuario que recién entra
    socket.emit('cargar_historial', historialSalas[sala]);
  });

  // Enviar mensaje a la sala actual
  socket.on('chat_message', (data) => {
    const sala = socket.salaActual || 'global';

    // Guardar en el historial de la sala (máximo 50 mensajes)
    if (!historialSalas[sala]) historialSalas[sala] = [];
    historialSalas[sala].push(data);
    if (historialSalas[sala].length > 50) historialSalas[sala].shift();

    // Reemitir solo a los usuarios en la misma sala
    io.to(sala).emit('chat_message', data);
  });

  // Votos de encuestas dentro de la sala
  socket.on('votar_encuesta', (data) => {
    const sala = socket.salaActual || 'global';
    io.to(sala).emit('actualizar_voto', data);
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
