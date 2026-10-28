# Servidor cooperativo

El juego web se publica como sitio estático; por eso el transporte de las partidas necesita un servicio Node.js externo. El servidor no almacena cuentas, guardados ni estado de la partida. Firebase sigue llevando cuentas, amigos, invitaciones y metadatos de sala.

## Requisitos

- Node.js 22 o posterior.
- Una máquina/servicio Node.js de una sola instancia, siempre encendido.
- Un nombre DNS con TLS. El cliente usa por defecto `wss://coop.pokesurvivor.com/rooms`.
- Credenciales de cuenta de servicio de Firebase Admin del proyecto `pokesurvivor-free`.

## Probar en localhost

No hace falta una clave de servicio para verificar ID tokens: Firebase Admin los
comprueba con las claves públicas de Firebase y el ID del proyecto. Abre dos
terminales en la raíz del repo.

Terminal 1:

```sh
npm run start:coop
```

Terminal 2:

```sh
python3 -m http.server 8000
```

Abre `http://localhost:8000/dev.html?dev`, inicia sesión con una cuenta real y
crea una sala. El cliente detecta localhost y conecta a
`ws://localhost:8787/rooms`; `localhost:8000` ya está permitido por el servidor.
Para probar desde otro puerto o máquina, define
`window.PS_COOP_SERVER_URL` antes de que cargue el juego y añade el origen exacto
a `COOP_ALLOWED_ORIGINS`. No desactives la verificación de Firebase.

## Arranque en producción

Instala las dependencias y ejecuta el servicio:

```sh
npm ci
GOOGLE_CLOUD_PROJECT=pokesurvivor-free \
COOP_ALLOWED_ORIGINS=https://pokesurvivor.com,https://www.pokesurvivor.com \
PORT=8787 npm run start:coop
```

El proceso escucha en `0.0.0.0:$PORT`; publica `/rooms` como WebSocket seguro y `/healthz` como comprobación HTTP. Termina TLS en el proxy inverso. Ejemplo de Caddy:

```text
coop.pokesurvivor.com {
    reverse_proxy 127.0.0.1:8787
}
```

Añade el registro DNS `coop` hacia la máquina y permite el tráfico HTTPS. No hace falta TURN ni un Worker. Una sola instancia es necesaria porque la lista de salas está en memoria; no actives varias réplicas sin añadir almacenamiento compartido y enrutamiento de sesión.

## Configuración del cliente

El cliente está preparado para `wss://coop.pokesurvivor.com/rooms`. Si el servidor usa otro dominio, cambia `SERVER_URL` en `js/net/net.js`. Para cada origen de desarrollo, añade su `origin` a `COOP_ALLOWED_ORIGINS`; no uses `*`. Después ejecuta el flujo habitual de build para regenerar `index.html` y `js/app.min.js`.

La autenticación usa el Firebase ID token de la sesión normal; no se comparten claves de servidor con el navegador. Sólo el UID del anfitrión puede crear su sala y autorizar miembros mediante el roster. Invitados pueden enviar frames sólo al anfitrión. Las conexiones y salas son temporales y se descartan al cerrar el proceso.

## Comprobaciones

```sh
npm run test:coop
curl http://127.0.0.1:8787/healthz
```

El despliegue no está activo hasta que el servicio esté alojado, el DNS apunte a él y las credenciales de Firebase Admin estén configuradas.
