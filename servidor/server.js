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
const estadoBloqueoSalas = {};
const usuariosActivos = {};

io.on('connection', (socket) => {

  socket.on('unirse_sala', (data) => {
    const { sala, usuario } = data;
    if (socket.salaActual) socket.leave(socket.salaActual);

    const esAdmin = usuario && usuario.startsWith('1234567890adminnn_');
    const nombreLimpio = esAdmin ? usuario.replace('1234567890adminnn_', '') : (usuario || 'Anónimo');

    socket.salaActual = sala || 'global';
    socket.join(socket.salaActual);

    socket.userData = { nombre: nombreLimpio, esAdmin: esAdmin };
    usuariosActivos[socket.id] = { id: socket.id, nombre: nombreLimpio, esAdmin: esAdmin, sala: socket.salaActual };

    if (!historialSalas[socket.salaActual]) historialSalas[socket.salaActual] = [];
    if (estadoBloqueoSalas[socket.salaActual] === undefined) estadoBloqueoSalas[socket.salaActual] = false;

    socket.emit('cargar_historial', historialSalas[socket.salaActual]);
    socket.emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[socket.salaActual] });
  });

  socket.on('toggle_bloqueo', () => {
    const sala = socket.salaActual || 'global';
    if (socket.userData && socket.userData.esAdmin) {
      estadoBloqueoSalas[sala] = !estadoBloqueoSalas[sala];
      const bloqueado = estadoBloqueoSalas[sala];

      io.to(sala).emit('estado_bloqueo', { bloqueado });

      const avisoSistema = {
        tipo: 'sistema',
        msgId: 'sys_' + Date.now(),
        texto: bloqueado ? '🔒 Un administrador ha bloqueado el chat.' : '🔓 Un administrador ha desbloqueado el chat.'
      };

      historialSalas[sala].push(avisoSistema);
      io.to(sala).emit('chat_message', avisoSistema);
    }
  });

  /* GESTIÓN Y SEÑALIZACIÓN WEBRTC (AUDIO & VIDEO) */
  socket.on('obtener_usuarios', () => {
    const salaUsers = Object.values(usuariosActivos).filter(u => u.sala === socket.salaActual);
    socket.emit('lista_usuarios', salaUsers);
  });

  socket.on('solicitar_llamada', (data) => {
    io.to(data.destinoId).emit('recibir_llamada', {
      emisorId: socket.id,
      emisorNombre: data.emisorNombre,
      conVideo: data.conVideo
    });
  });

  socket.on('responder_llamada', (data) => {
    io.to(data.destinoId).emit('respuesta_llamada', {
      aceptada: data.aceptada,
      emisorId: socket.id
    });
  });

  socket.on('webrtc_signal', (data) => {
    io.to(data.destinoId).emit('webrtc_signal', {
      emisorId: socket.id,
      signal: data.signal
    });
  });

  socket.on('chat_message', (data) => {
    const sala = socket.salaActual || 'global';
    if (estadoBloqueoSalas[sala] && !data.esAdmin) return;

    data.msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    if (!historialSalas[sala]) historialSalas[sala] = [];
    historialSalas[sala].push(data);
    if (historialSalas[sala].length > 50) historialSalas[sala].shift();

    io.to(sala).emit('chat_message', data);
  });

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

  socket.on('disconnect', () => {
    delete usuariosActivos[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
