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
const estadoBloqueoSalas = {}; // Guarda estado de bloqueo por sala

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

    // Si la sala está bloqueada y no es admin, no procesa mensaje
    if (estadoBloqueoSalas[sala] && !data.esAdmin) return;

    data.msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    data.reacciones = {}; // Objeto para guardar { emoji: [usuarios] }

    if (!historialSalas[sala]) historialSalas[sala] = [];
    historialSalas[sala].push(data);
    if (historialSalas[sala].length > 50) historialSalas[sala].shift();

    io.to(sala).emit('chat_message', data);
  });

  // Votar o alternar (quitar) voto en encuestas
  socket.on('votar_encuesta', (data) => {
    const sala = socket.salaActual || 'global';
    const historial = historialSalas[sala];

    if (!historial) return;

    const mensajeEncuesta = historial.find(m => m.encuestaId === data.encuestaId);
    if (mensajeEncuesta && mensajeEncuesta.opciones[data.opcionIndex]) {
      
      // Remover voto previo de esta misma persona en cualquiera de las opciones
      mensajeEncuesta.opciones.forEach((opcion, idx) => {
        if (!opcion.votantes) opcion.votantes = [];
        const pos = opcion.votantes.indexOf(data.usuario);
        if (pos !== -1 && idx !== data.opcionIndex) {
          opcion.votantes.splice(pos, 1);
        }
      });

      const opcionActual = mensajeEncuesta.opciones[data.opcionIndex];
      if (!opcionActual.votantes) opcionActual.votantes = [];

      const yaVoto = opcionActual.votantes.indexOf(data.usuario);
      if (yaVoto !== -1) {
        // Si ya había votado por esta opción, quitamos el voto
        opcionActual.votantes.splice(yaVoto, 1);
      } else {
        // Agregar voto
        opcionActual.votantes.push(data.usuario);
      }

      io.to(sala).emit('actualizar_voto', {
        encuestaId: data.encuestaId,
        opciones: mensajeEncuesta.opciones
      });
    }
  });

  // Reacciones a mensajes
  socket.on('reaccionar_mensaje', (data) => {
    const sala = socket.salaActual || 'global';
    const historial = historialSalas[sala];
    if (!historial) return;

    const msg = historial.find(m => m.msgId === data.msgId);
    if (msg) {
      if (!msg.reacciones) msg.reacciones = {};
      if (!msg.reacciones[data.emoji]) msg.reacciones[data.emoji] = [];

      const userIndex = msg.reacciones[data.emoji].indexOf(data.usuario);
      if (userIndex !== -1) {
        msg.reacciones[data.emoji].splice(userIndex, 1);
      } else {
        msg.reacciones[data.emoji].push(data.usuario);
      }

      io.to(sala).emit('actualizar_reacciones', {
        msgId: data.msgId,
        reacciones: msg.reacciones,
        emojiReaccionado: data.emoji
      });
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
      const bloqueado = estadoBloqueoSalas[sala];
      const adminNombre = socket.userData.nombre;

      const mensajeSistema = {
        tipo: 'sistema',
        texto: bloqueado 
          ? `🔒 El administrador ${adminNombre} ha bloqueado el chat.` 
          : `🔓 El administrador ${adminNombre} ha desbloqueado el chat.`,
        msgId: 'sys_' + Date.now()
      };

      if (!historialSalas[sala]) historialSalas[sala] = [];
      historialSalas[sala].push(mensajeSistema);

      io.to(sala).emit('estado_bloqueo', { bloqueado });
      io.to(sala).emit('chat_message', mensajeSistema);
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));
