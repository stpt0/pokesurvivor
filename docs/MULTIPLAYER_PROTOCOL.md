# Protocolo cooperativo por WebSocket

La partida usa topología en estrella con un anfitrión que simula enemigos,
objetos, experiencia, reloj y fin de partida. Cada jugador simula su propio
Pokémon. Un servidor Node.js autentica las conexiones y retransmite los mensajes;
no ejecuta la simulación ni guarda partidas.

## Conexión

1. El cliente abre `wss://coop.pokesurvivor.com/rooms` (se puede cambiar con
   `window.PS_COOP_SERVER_URL` antes de cargar el juego).
2. Envía `{ k: "auth", token, room }`, donde `token` es un Firebase ID token y
   `room` es el UID del anfitrión.
3. El servidor verifica el token con Firebase Admin. El anfitrión crea la sala;
   el servidor sólo admite otros UIDs cuando el anfitrión los incluye en
   `{ k: "roster", members: [...] }`.
4. El servidor responde `{ k: "joined", uid, host, peers }` y notifica cambios
   con `{ k: "presence", uid, online }`.

Firebase Realtime Database y Firestore mantienen las salas, invitaciones y
amistades como antes. La negociación ICE, WebRTC, TURN y el relé de mensajes por
Realtime Database ya no forman parte del transporte de partida.

## Mensajes

Cada frame de juego viaja como JSON en un WebSocket:

- Cliente → servidor: `{ k: "data", to, msg }`.
- Servidor → destinatario: `{ k: "data", from, msg }`.
- Invitados sólo pueden enviar al anfitrión; sólo el anfitrión puede enviar a
  otros miembros. Se conserva la autoridad de juego existente en `coop.js`.
- El roster limita cada sala a cuatro jugadores. La conexión admite hasta 90
  mensajes por segundo por cliente y 256 KiB por mensaje.

La desconexión de un anfitrión conserva temporalmente la sala durante 15 s para
permitir que vuelva a conectarse. Las salas y los frames sólo viven en memoria;
reiniciar el proceso cierra las conexiones, y los clientes se reconectan con un
nuevo token. Las métricas `G.Net.stats` cuentan bytes del payload de juego, no
el coste total de red.

## Despliegue

El sitio estático de GitHub Pages no puede ejecutar Node.js. El servidor necesita
una máquina o servicio Node.js siempre disponible, DNS propio y TLS WebSocket.
Los pasos y variables están en [COOP_SERVER.md](COOP_SERVER.md). La clave de
Firebase Admin se guarda sólo en el host, nunca en el repo ni en el navegador.