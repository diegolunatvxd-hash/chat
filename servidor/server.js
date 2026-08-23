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
    const { sala, usuario, esAdmin } = data;
    if (socket.salaActual) socket.leave(socket.salaActual);

    socket.salaActual = sala || 'global';
    socket.join(socket.salaActual);

    socket.userData = { nombre: usuario || 'Anónimo', esAdmin: !!esAdmin };
    usuariosActivos[socket.id] = { id: socket.id, nombre: socket.userData.nombre, sala: socket.salaActual };

    if (!historialSalas[socket.salaActual]) historialSalas[socket.salaActual] = [];
    if (estadoBloqueoSalas[socket.salaActual] === undefined) estadoBloqueoSalas[socket.salaActual] = false;

    socket.emit('cargar_historial', historialSalas[socket.salaActual]);
    socket.emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[socket.salaActual] });
  });

  /* LLAMADAS WEBRTC / P2P SIGNALS */
  socket.on('obtener_usuarios', () => {
    const salaUsers = Object.values(usuariosActivos).filter(u => u.sala === socket.salaActual);
    socket.emit('lista_usuarios', salaUsers);
  });

  socket.on('solicitar_llamada', (data) => {
    io.to(data.destinoId).emit('recibir_llamada', {
      emisorId: socket.id,
      emisorNombre: data.emisorNombre
    });
  });

  socket.on('responder_llamada', (data) => {
    io.to(data.destinoId).emit('respuesta_llamada', {
      aceptada: data.aceptada,
      emisorId: socket.id
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
