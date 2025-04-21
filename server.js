const mineflayer = require('mineflayer');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const CONFIG_PATH = path.resolve(__dirname, 'config.json');

let config = {
  accounts: [
    { username: 'you@example.com', auth: 'microsoft' }
  ],
  selectedAccount: 0,
  host:               'your.server.address',
  port:               25565,
  wiggleInterval:     30000,
  wiggleAmplitude:    0.1,
  chatPingEnabled:    false,
  chatPingInterval:   300000,
  chatPingMessage:    'afk',
  afkRetryInterval:   5000
};
let lastAFKCommand = null;
let bot = null;
let timers = [];

try {
  if (fs.existsSync(CONFIG_PATH)) {
    Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  }
} catch (err) {
  console.error('Error loading config:', err);
}

app.use(express.json());
app.use(express.static(__dirname));

function emitStatus() {
  io.emit('status', {
    accounts:           config.accounts,
    selectedAccount:    config.selectedAccount,
    connected:          bot && bot.entity ? true : false,
    username:           bot ? bot.username : '—',
    host:               config.host,
    port:               config.port,
    wiggleInterval:     config.wiggleInterval,
    wiggleAmplitude:    config.wiggleAmplitude,
    chatPingEnabled:    config.chatPingEnabled,
    chatPingInterval:   config.chatPingInterval,
    chatPingMessage:    config.chatPingMessage,
    afkRetryInterval:   config.afkRetryInterval
  });
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    log('⚙️ Settings saved');
  } catch (err) {
    log(`❌ Could not save config: ${err.message}`);
  }
}

function log(msg) {
  io.emit('log', msg);
}

function clearTimers() {
  timers.forEach(clearInterval);
  timers = [];
}

function startBot() {
  if (bot) {
    bot.end();
    bot.removeAllListeners();
  }
  clearTimers();

  const account = config.accounts[config.selectedAccount] || config.accounts[0];
  bot = mineflayer.createBot({
    host:     config.host,
    port:     config.port,
    auth:     account.auth,
    username: account.username
  });

  bot.once('spawn', () => {
    log(`✔️ Logged in as ${bot.username}`);
    emitStatus();

    if (config.wiggleInterval > 0) {
      timers.push(setInterval(() => {
        bot.look(bot.entity.yaw + config.wiggleAmplitude, bot.entity.pitch, false);
      }, config.wiggleInterval));
    }

    if (config.chatPingEnabled && config.chatPingInterval > 0) {
      timers.push(setInterval(() => {
        bot.chat(config.chatPingMessage);
      }, config.chatPingInterval));
    }
  });

  bot.on('message', msg => {
    const text = msg.toString();
    log(`[CHAT] ${text}`);
    if (text.toLowerCase().includes('region is full')) {
      log(`⚠️ Region full, retrying in ${config.afkRetryInterval}ms`);
      timers.push(setTimeout(() => {
        if (lastAFKCommand) bot.chat(lastAFKCommand);
      }, config.afkRetryInterval));
    }
  });

  bot.on('kicked', reason => {
    log(`❌ Kicked: ${JSON.stringify(reason)}`);
    emitStatus();
    setTimeout(startBot, 5000);
  });

  bot.on('end', () => {
    log('⚠️ Disconnected');
    emitStatus();
  });

  bot.on('error', err => {
    log(`⚠️ Error: ${err.message}`);
    console.error(err);
  });
}

io.on('connection', socket => {
  emitStatus();

  socket.on('addAccount', data => {
    config.accounts.push({ username: data.username, auth: data.auth });
    saveConfig();
    emitStatus();
  });

  socket.on('setSettings', data => {
    config.selectedAccount  = parseInt(data.selectedAccount, 10);
    config.host             = data.host;
    config.port             = parseInt(data.port, 10);
    config.wiggleInterval   = parseInt(data.wiggleInterval, 10);
    config.wiggleAmplitude  = parseFloat(data.wiggleAmplitude);
    config.chatPingEnabled  = data.chatPingEnabled === 'on';
    config.chatPingInterval = parseInt(data.chatPingInterval, 10);
    config.chatPingMessage  = data.chatPingMessage;
    config.afkRetryInterval = parseInt(data.afkRetryInterval, 10);

    saveConfig();
    log('⚙️ Restarting bot with new settings…');
    startBot();
  });

  socket.on('sendChat', text => {
    if (bot && bot.chat) {
      if (text.trim().startsWith('/afk')) {
        lastAFKCommand = text.trim();
      }
      bot.chat(text);
      log(`[YOU] ${text}`);
    }
  });
});

const WEB_PORT = 3000;
server.listen(WEB_PORT, () => {
  console.log(`UI at http://localhost:${WEB_PORT}`);
  start
