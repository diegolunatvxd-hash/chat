const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(__dirname));

const historialSalas = {};
const estadoBloqueoSalas = {}; // Guarda si la sala está bloqueada

io.on('connection', (socket) => {

  socket.on('unirse_sala', (data) => {
    const { sala, usuario } = data;
    
    if (socket.salaActual) {
      socket.leave(socket.salaActual);
    }

    socket.salaActual = sala;
    socket.join(sala);

    // Detección de Admin mediante la clave
    const esAdmin = usuario && usuario.startsWith('1234567890adminnn_');
    const nombreLimpio = esAdmin ? usuario.replace('1234567890adminnn_', '') : usuario;

    socket.userData = {
      nombre: nombreLimpio,
      esAdmin: esAdmin
    };

    if (!historialSalas[sala]) historialSalas[sala] = [];
    if (estadoBloqueoSalas[sala] === undefined) estadoBloqueoSalas[sala] = false;

    // Enviar historial y estado de bloqueo
    socket.emit('cargar_historial', historialSalas[sala]);
    socket.emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[sala] });
  });

  socket.on('chat_message', (data) => {
    const sala = socket.salaActual || 'global';

    // Si la sala está bloqueada y no es admin, se bloquea el mensaje
    if (estadoBloqueoSalas[sala] && !data.esAdmin) return;

    data.msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    if (!historialSalas[sala]) historialSalas[sala] = [];
    historialSalas[sala].push(data);
    if (historialSalas[sala].length > 50) historialSalas[sala].shift();

    io.to(sala).emit('chat_message', data);
  });

  // Votar en encuestas (Registra qué usuario votó)
  socket.on('votar_encuesta', (data) => {
    const sala = socket.salaActual || 'global';
    const historial = historialSalas[sala];

    if (!historial) return;

    const mensajeEncuesta = historial.find(m => m.encuestaId === data.encuestaId);
    if (mensajeEncuesta && mensajeEncuesta.opciones[data.opcionIndex]) {
      const opcion = mensajeEncuesta.opciones[data.opcionIndex];
      if (!opcion.votantes) opcion.votantes = [];

      // Evitar que vote dos veces la misma persona
      if (!opcion.votantes.includes(data.usuario)) {
        opcion.votantes.push(data.usuario);
        io.to(sala).emit('actualizar_voto', {
          encuestaId: data.encuestaId,
          opciones: mensajeEncuesta.opciones
        });
      }
    }
  });

  // Eliminar mensaje (Propio o cualquiera si es Admin)
  socket.on('eliminar_mensaje', (data) => {
    const sala = socket.salaActual || 'global';
    if (!historialSalas[sala]) return;

    const index = historialSalas[sala].findIndex(m => m.msgId === data.msgId);
    if (index !== -1) {
      const msg = historialSalas[sala][index];
      if (socket.userData.esAdmin || msg.id === socket.id) {
        historialSalas[sala].splice(index, 1);
        io.to(sala).emit('mensaje_eliminado', { msgId: data.msgId });
      }
    }
  });

  // Alternar bloqueo de sala (Solo Admin)
  socket.on('toggle_bloqueo', () => {
    const sala = socket.salaActual || 'global';
    if (socket.userData && socket.userData.esAdmin) {
      estadoBloqueoSalas[sala] = !estadoBloqueoSalas[sala];
      io.to(sala).emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[sala] });
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
