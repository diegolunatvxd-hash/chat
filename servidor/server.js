const express = require('express');
const app = express();
const http = require('http').Server(app);
const { createClient } = require('@supabase/supabase-js');
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(__dirname));

// CONFIGURACIÓN DE SUPABASE
//no cambiar inicio
const SUPABASE_URL = 'https://mfzndmlvtjsbkijhrsoz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mem5kbWx2dGpzYmtpamhyc296Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzQ5NzgyMywiZXhwIjoyMTAzMDczODIzfQ.FkqEBJAfS_rBWXvzIJ019FpMeVnnfwVOhpN_v88sA8M';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
//no cambiar fin

const estadoBloqueoSalas = {};
const usuariosActivos = {};

// Subir multimedia a Supabase Storage
async function subirArchivoSupabase(base64Data, tipo) {
  try {
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return base64Data;

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = mimeType.split('/')[1].split(';')[0] || 'bin';
    const fileName = `${tipo}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${ext}`;

    const { error } = await supabase.storage
      .from('chat-media')
      .upload(fileName, buffer, { contentType: mimeType, upsert: true });

    if (error) throw error;

    const { data: publicUrlData } = supabase.storage
      .from('chat-media')
      .getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error("Error al subir archivo a Supabase Storage:", err);
    return base64Data;
  }
}

io.on('connection', (socket) => {

  // AUTENTICACIÓN / REGISTRO / LOGIN
  socket.on('autenticar_usuario', async (data, callback) => {
    const { usuario, password, color, foto, esAdminClave, esRegistro } = data;

    // Si es entrada como Invitado sin contraseña
    if (!password || password.trim() === '') {
      const esAdmin = usuario && usuario.startsWith('1234567890adminnn_');
      const nombreLimpio = esAdmin ? usuario.replace('1234567890adminnn_', '') : (usuario || 'Anónimo');
      return callback({
        exito: true,
        perfil: {
          nombre: nombreLimpio,
          color: color || '#005c4b',
          foto: foto || '',
          esAdmin: esAdmin
        }
      });
    }

    try {
      if (esRegistro) {
        // Buscar si el usuario ya existe
        const { data: userExistente, error: errorUsuario } = await supabase
          .from('usuarios')
          .select('*')
          .eq('usuario', usuario)
          .maybeSingle();

        if (errorUsuario) {
          console.error("Error buscando usuario:", errorUsuario);
          return callback({ exito: false, mensaje: 'Error al comprobar el usuario.' });
        }

        if (userExistente) {
          return callback({ exito: false, mensaje: 'El usuario ya existe.' });
        }

        // Buscar si la contraseña ya está utilizada por otra cuenta
        const { data: passwordExistente, error: errorPassword } = await supabase
          .from('usuarios')
          .select('usuario')
          .eq('password', password)
          .maybeSingle();

        if (errorPassword) {
          console.error("Error comprobando contraseña:", errorPassword);
          return callback({ exito: false, mensaje: 'Error al comprobar la contraseña.' });
        }

        if (passwordExistente) {
          return callback({ exito: false, mensaje: 'Esta contraseña ya está en uso. Elige otra.' });
        }

        let fotoUrl = foto;
        if (foto && foto.startsWith('data:')) {
          fotoUrl = await subirArchivoSupabase(foto, 'perfil');
        }

        const esAdmin = esAdminClave || usuario.startsWith('1234567890adminnn_');
        const nombreGuardar = usuario.replace('1234567890adminnn_', '');

        const { data: nuevoUser, error: errIns } = await supabase
          .from('usuarios')
          .insert([{
            usuario: nombreGuardar,
            password: password,
            color: color || '#005c4b',
            foto_perfil: fotoUrl || '',
            es_admin: esAdmin
          }])
          .select()
          .single();

        if (errIns) {
          return callback({ exito: false, mensaje: 'Error al registrar usuario.' });
        }

        return callback({
          exito: true,
          perfil: {
            nombre: nuevoUser.usuario,
            color: nuevoUser.color,
            foto: nuevoUser.foto_perfil,
            esAdmin: nuevoUser.es_admin
          }
        });
      } else {
        // Inicio de sesión usando únicamente la contraseña
        const { data: userBD, error } = await supabase
          .from('usuarios')
          .select('*')
          .eq('password', password)
          .maybeSingle();

        if (error) {
          console.error("Error buscando usuario por contraseña:", error);
          return callback({ exito: false, mensaje: 'Error al iniciar sesión.' });
        }

        if (!userBD) {
          return callback({ exito: false, mensaje: 'Contraseña incorrecta o cuenta no encontrada.' });
        }

        return callback({
          exito: true,
          perfil: {
            nombre: userBD.usuario,
            color: userBD.color,
            foto: userBD.foto_perfil,
            esAdmin: userBD.es_admin
          }
        });
      }
    } catch (e) {
      console.error("Error autenticando:", e);
      return callback({ exito: false, mensaje: 'Error en el servidor.' });
    }
  });

  socket.on('unirse_sala', async (data) => {
    const { sala, perfil } = data;
    if (socket.salaActual) socket.leave(socket.salaActual);

    socket.salaActual = sala || 'global';
    socket.join(socket.salaActual);

    socket.userData = {
      nombre: perfil.nombre,
      color: perfil.color,
      foto: perfil.foto,
      esAdmin: perfil.esAdmin
    };

    usuariosActivos[socket.id] = {
      id: socket.id,
      nombre: perfil.nombre,
      color: perfil.color,
      foto: perfil.foto,
      esAdmin: perfil.esAdmin,
      sala: socket.salaActual
    };

    if (estadoBloqueoSalas[socket.salaActual] === undefined) estadoBloqueoSalas[socket.salaActual] = false;

    // CARGAR ÚLTIMOS 50 MENSAJES
    try {
      const { data: mensajesBD, error } = await supabase
        .from('mensajes')
        .select('*')
        .eq('sala', socket.salaActual)
        .order('created_at', { ascending: true })
        .limit(50);

      if (!error && mensajesBD) {
        const historial = mensajesBD.map(m => ({
          msgId: m.msg_id,
          tipo: m.tipo,
          texto: m.texto,
          contenido: m.contenido,
          pregunta: m.pregunta,
          opciones: m.opciones,
          votos: m.votos || {},
          nombre: m.nombre,
          color: m.color,
          foto: m.foto_perfil,
          esAdmin: m.es_admin
        }));
        socket.emit('cargar_historial', historial);
      }
    } catch (e) {
      console.error("Error cargando historial de Supabase:", e);
    }

    socket.emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[socket.salaActual] });
  });

  socket.on('chat_message', async (data) => {
    const sala = socket.salaActual || 'global';
    if (estadoBloqueoSalas[sala] && !data.esAdmin) return;

    if (!data.msgId) {
      data.msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    }

    if (data.tipo === 'encuesta' && !data.votos) data.votos = {};

    if ((data.tipo === 'foto' || data.tipo === 'audio') && data.contenido.startsWith('data:')) {
      data.contenido = await subirArchivoSupabase(data.contenido, data.tipo);
    }

    try {
      await supabase.from('mensajes').insert([{
        msg_id: data.msgId,
        sala: sala,
        tipo: data.tipo,
        texto: data.texto || null,
        contenido: data.contenido || null,
        pregunta: data.pregunta || null,
        opciones: data.opciones || null,
        votos: data.votos || null,
        nombre: data.nombre,
        color: data.color,
        foto_perfil: data.foto,
        es_admin: data.esAdmin || false
      }]);
    } catch (err) {
      console.error("Error al guardar mensaje en Supabase:", err);
    }

    io.to(sala).emit('chat_message', data);
  });

  socket.on('votar_encuesta', async (data) => {
    const sala = socket.salaActual || 'global';

    try {
      const { data: res } = await supabase
        .from('mensajes')
        .select('*')
        .eq('msg_id', data.msgId)
        .single();

      if (res) {
        let votos = res.votos || {};

        Object.keys(votos).forEach(opt => {
          votos[opt] = votos[opt].filter(u => u !== data.usuarioNombre);
        });

        if (!votos[data.opcionIndex]) votos[data.opcionIndex] = [];
        votos[data.opcionIndex].push(data.usuarioNombre);

        await supabase
          .from('mensajes')
          .update({ votos: votos })
          .eq('msg_id', data.msgId);

        const msgActualizado = {
          msgId: res.msg_id,
          tipo: res.tipo,
          pregunta: res.pregunta,
          opciones: res.opciones,
          votos: votos,
          nombre: res.nombre,
          color: res.color,
          foto: res.foto_perfil,
          esAdmin: res.es_admin
        };

        io.to(sala).emit('chat_message', msgActualizado);
      }
    } catch (e) {
      console.error("Error al votar encuesta:", e);
    }
  });

  socket.on('eliminar_mensaje', async (data) => {
    const sala = socket.salaActual || 'global';
    try {
      await supabase.from('mensajes').delete().eq('msg_id', data.msgId);
      io.to(sala).emit('mensaje_eliminado', { msgId: data.msgId });
    } catch (e) {
      console.error("Error eliminando mensaje de Supabase:", e);
    }
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

      io.to(sala).emit('chat_message', avisoSistema);
    }
  });

  /* WEBRTC HANDLERS */
  socket.on('obtener_usuarios', () => {
    const salaUsers = Object.values(usuariosActivos).filter(u => u.sala === socket.salaActual);
    socket.emit('lista_usuarios', salaUsers);
  });

  socket.on('solicitar_llamada', (data) => {
    io.to(data.destinoId).emit('recibir_llamada', { emisorId: socket.id, emisorNombre: data.emisorNombre, conVideo: data.conVideo });
  });

  socket.on('responder_llamada', (data) => {
    io.to(data.destinoId).emit('respuesta_llamada', { aceptada: data.aceptada, emisorId: socket.id });
  });

  socket.on('webrtc_signal', (data) => {
    io.to(data.destinoId).emit('webrtc_signal', { emisorId: socket.id, signal: data.signal });
  });

  socket.on('disconnect', () => {
    delete usuariosActivos[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
        
