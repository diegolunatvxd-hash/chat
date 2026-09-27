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
const SUPABASE_URL = 'https://mfzndmlvtjsbkijhrsoz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mem5kbWx2dGpzYmtpamhyc296Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzQ5NzgyMywiZXhwIjoyMTAzMDczODIzfQ.FkqEBJAfS_rBWXvzIJ019FpMeVnnfwVOhpN_v88sA8M';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const estadoBloqueoSalas = {};
const usuariosActivos = {};

async function subirArchivoSupabase(base64Data, tipo) {
  try {
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return base64Data;

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = mimeType.split('/')[1].split(';')[0] || 'bin';
    const fileName = `${tipo}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${ext}`;

    const { error } = await supabase.storage.from('chat-media').upload(fileName, buffer, { contentType: mimeType, upsert: true });
    if (error) throw error;

    const { data: publicUrlData } = supabase.storage.from('chat-media').getPublicUrl(fileName);
    return publicUrlData.publicUrl;
  } catch (err) {
    console.error("Error subiendo archivo:", err);
    return base64Data;
  }
}

io.on('connection', (socket) => {

  // AUTENTICACIÓN Y REGISTRO CON IDENTIFICADOR
  socket.on('autenticar_usuario', async (data, callback) => {
    const { usuario, password, identificador, color, foto, esAdminClave, esRegistro } = data;

    // Invitado
    if (!password || password.trim() === '') {
      const nombreLimpio = usuario || 'Anónimo';
      return callback({
        exito: true,
        perfil: { nombre: nombreLimpio, identificador: 'invitado_'+socket.id, color: color || '#005c4b', foto: foto || '', esAdmin: false },
        misChats: [] 
      });
    }

    try {
      let userLogueado;
      if (esRegistro) {
        if (!identificador) return callback({ exito: false, mensaje: 'El identificador es obligatorio.' });
        
        // Verificar existencia de usuario o identificador
        const { data: userExistente } = await supabase.from('usuarios').select('*').or(`usuario.eq.${usuario},identificador.eq.${identificador}`).maybeSingle();
        if (userExistente) return callback({ exito: false, mensaje: 'El usuario o identificador ya existe.' });

        let fotoUrl = foto;
        if (foto && foto.startsWith('data:')) fotoUrl = await subirArchivoSupabase(foto, 'perfil');

        const esAdmin = esAdminClave || usuario.startsWith('1234567890adminnn_');
        const nombreGuardar = usuario.replace('1234567890adminnn_', '');

        const { data: nuevoUser, error: errIns } = await supabase.from('usuarios').insert([{
          usuario: nombreGuardar, password: password, identificador: identificador, color: color || '#005c4b', foto_perfil: fotoUrl || '', es_admin: esAdmin
        }]).select().single();

        if (errIns) return callback({ exito: false, mensaje: 'Error al registrar usuario.' });
        userLogueado = nuevoUser;
      } else {
        // Logueo requiere identificador y password
        const { data: userBD, error } = await supabase.from('usuarios').select('*').eq('identificador', identificador).eq('password', password).maybeSingle();
        if (error || !userBD) return callback({ exito: false, mensaje: 'Credenciales incorrectas.' });
        userLogueado = userBD;
      }

      const { data: misChatsBD } = await supabase.from('chats_participantes').select('*').eq('identificador', userLogueado.identificador);

      return callback({
        exito: true,
        perfil: { nombre: userLogueado.usuario, identificador: userLogueado.identificador, color: userLogueado.color, foto: userLogueado.foto_perfil, esAdmin: userLogueado.es_admin },
        misChats: misChatsBD || []
      });

    } catch (e) {
      console.error(e);
      return callback({ exito: false, mensaje: 'Error en el servidor.' });
    }
  });

  // CREAR DM O AÑADIR A GRUPO POR IDENTIFICADOR
  socket.on('crear_o_anadir_por_id', async (data, callback) => {
    // data = { accion: 'dm' o 'grupo', identificadorTarget, miIdentificador, miNombre, salaActual }
    try {
        const { data: targetUser } = await supabase.from('usuarios').select('*').eq('identificador', data.identificadorTarget).maybeSingle();
        if(!targetUser) return callback({ exito: false, mensaje: 'No se encontró a nadie con ese identificador.' });

        if(data.accion === 'dm') {
            const arr = [data.miIdentificador, targetUser.identificador].sort();
            const salaId = 'dm_' + arr[0] + '_' + arr[1];
            
            await supabase.from('chats_participantes').upsert([
                { sala: salaId, tipo: 'dm', usuario: data.miNombre, identificador: data.miIdentificador, nombre_chat: targetUser.usuario },
                { sala: salaId, tipo: 'dm', usuario: targetUser.usuario, identificador: targetUser.identificador, nombre_chat: data.miNombre }
            ], { onConflict: 'sala,identificador' });
            
            callback({ exito: true, chat: { sala: salaId, tipo: 'dm', nombre_chat: targetUser.usuario } });
            
            // Notificar al otro si está conectado
            const socketOtro = Object.values(usuariosActivos).find(u => u.identificador === targetUser.identificador);
            if (socketOtro) io.to(socketOtro.id).emit('chat_creado', { sala: salaId, tipo: 'dm', nombre_chat: data.miNombre });
            
        } else if (data.accion === 'grupo') {
            if(data.salaActual === 'global' || data.salaActual.startsWith('dm_')) return callback({exito:false, mensaje: 'Crea o únete a un grupo privado primero.'});
            
            await supabase.from('chats_participantes').upsert({
                sala: data.salaActual, tipo: 'grupo', usuario: targetUser.usuario, identificador: targetUser.identificador, nombre_chat: data.salaActual
            }, { onConflict: 'sala,identificador' });
            
            callback({ exito: true, mensaje: `Añadido ${targetUser.usuario} al grupo.` });
        }
    } catch(e) {
        callback({ exito: false, mensaje: 'Error al procesar la solicitud.' });
    }
  });

  socket.on('unirse_sala', async (data) => {
    const { sala, perfil, nombreChat } = data;
    if (socket.salaActual) socket.leave(socket.salaActual);

    socket.salaActual = sala || 'global';
    socket.join(socket.salaActual);

    usuariosActivos[socket.id] = { id: socket.id, nombre: perfil.nombre, identificador: perfil.identificador, sala: socket.salaActual };

    if (estadoBloqueoSalas[socket.salaActual] === undefined) estadoBloqueoSalas[socket.salaActual] = false;

    if (!perfil.identificador.startsWith('invitado_')) {
        const tipoSala = sala === 'global' ? 'global' : (sala.startsWith('dm_') ? 'dm' : 'grupo');
        const nombreGuardar = nombreChat || (sala === 'global' ? '🌐 Global' : sala);
        try {
            await supabase.from('chats_participantes').upsert({
                sala: sala, tipo: tipoSala, usuario: perfil.nombre, identificador: perfil.identificador, nombre_chat: nombreGuardar
            }, { onConflict: 'sala,identificador' });
        } catch(e) { console.log(e) }
    }

    try {
      const { data: mensajesBD, error } = await supabase.from('mensajes').select('*').eq('sala', socket.salaActual).order('created_at', { ascending: true }).limit(50);
      if (!error && mensajesBD) {
        const historial = mensajesBD.map(m => ({
          msgId: m.msg_id, tipo: m.tipo, texto: m.texto, contenido: m.contenido, identificador: m.identificador, pregunta: m.pregunta, opciones: m.opciones, votos: m.votos || {}, nombre: m.nombre, color: m.color, foto: m.foto_perfil, esAdmin: m.es_admin
        }));
        socket.emit('cargar_historial', historial);
      }
    } catch (e) {}
    socket.emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[socket.salaActual] });
  });

  socket.on('chat_message', async (data) => {
    const sala = socket.salaActual || 'global';
    if (estadoBloqueoSalas[sala] && !data.esAdmin) return;
    if (!data.msgId) data.msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    if ((data.tipo === 'foto' || data.tipo === 'audio') && data.contenido.startsWith('data:')) {
      data.contenido = await subirArchivoSupabase(data.contenido, data.tipo);
    }

    try {
      await supabase.from('mensajes').insert([{
        msg_id: data.msgId, sala: sala, tipo: data.tipo, texto: data.texto || null, contenido: data.contenido || null, identificador: data.identificador, pregunta: data.pregunta || null, opciones: data.opciones || null, votos: data.votos || null, nombre: data.nombre, color: data.color, foto_perfil: data.foto, es_admin: data.esAdmin || false
      }]);
    } catch (err) { console.log(err) }

    io.to(sala).emit('chat_message', data);
  });

  // RESTO DE CÓDIGO WEBRTC, VOTACIONES Y BORRADOS IGUAL
  socket.on('votar_encuesta', async (data) => {
    const sala = socket.salaActual || 'global';
    try {
      const { data: res } = await supabase.from('mensajes').select('*').eq('msg_id', data.msgId).single();
      if (res) {
        let votos = res.votos || {};
        Object.keys(votos).forEach(opt => { votos[opt] = votos[opt].filter(u => u !== data.usuarioNombre); });
        if (!votos[data.opcionIndex]) votos[data.opcionIndex] = [];
        votos[data.opcionIndex].push(data.usuarioNombre);

        await supabase.from('mensajes').update({ votos: votos }).eq('msg_id', data.msgId);
        io.to(sala).emit('chat_message', { msgId: res.msg_id, tipo: res.tipo, pregunta: res.pregunta, opciones: res.opciones, votos: votos, identificador: res.identificador, nombre: res.nombre, color: res.color, foto: res.foto_perfil, esAdmin: res.es_admin });
      }
    } catch (e) {}
  });

  socket.on('eliminar_mensaje', async (data) => {
    const sala = socket.salaActual || 'global';
    try { await supabase.from('mensajes').delete().eq('msg_id', data.msgId); io.to(sala).emit('mensaje_eliminado', { msgId: data.msgId }); } catch (e) {}
  });

  socket.on('toggle_bloqueo', (data) => {
    const sala = socket.salaActual || 'global';
    estadoBloqueoSalas[sala] = !estadoBloqueoSalas[sala];
    io.to(sala).emit('estado_bloqueo', { bloqueado: estadoBloqueoSalas[sala] });
    io.to(sala).emit('chat_message', { tipo: 'sistema', msgId: 'sys_'+Date.now(), texto: estadoBloqueoSalas[sala] ? '🔒 Chat bloqueado.' : '🔓 Chat desbloqueado.' });
  });

  socket.on('obtener_usuarios', () => socket.emit('lista_usuarios', Object.values(usuariosActivos).filter(u => u.sala === socket.salaActual)));
  socket.on('solicitar_llamada', (data) => { io.to(data.destinoId).emit('recibir_llamada', { emisorId: socket.id, emisorNombre: data.emisorNombre, conVideo: data.conVideo }); });
  socket.on('responder_llamada', (data) => { io.to(data.destinoId).emit('respuesta_llamada', { aceptada: data.aceptada, emisorId: socket.id }); });
  socket.on('webrtc_signal', (data) => { io.to(data.destinoId).emit('webrtc_signal', { emisorId: socket.id, signal: data.signal }); });
  socket.on('disconnect', () => { delete usuariosActivos[socket.id]; });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
