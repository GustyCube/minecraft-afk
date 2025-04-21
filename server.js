const mineflayer = require('mineflayer');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');
const session    = require('express-session');
const bodyParser = require('body-parser');
const bcrypt     = require('bcryptjs');
const { msaAuth } = require('mineflayer');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const USERS_PATH = path.resolve(__dirname, 'users.json');

let config = {
  accounts: [],
  selectedAccount: 0,
  host:               'your.server.address',
  port:               25565,
  wiggleInterval:     30000,
  wiggleAmplitude:    0.1,
  chatPingEnabled:    false,
  chatPingInterval:   300000,
  chatPingMessage:    'afk',
  afkRetryInterval:   5000,
  autoReconnect: {
    enabled:          true,
    delay:            5000,
    onJoinCommand:    '',
    maxAttempts:      -1  
  },
  physics: {
    jumpEnabled:      true,
    sprintEnabled:    false,
    sneakEnabled:     false,
    gravity:          0.08,
    airBoost:         0.005,
    jumpBoost:        0.42,
    waterSpeed:       0.02,
    swimSpeed:        0.02,
    terminalVelocity: 3.92
  },
  movement: {
    autoJump:         true,
    autoJumpHeight:   1.0,
    maxSpeed:         4.317,
    walkSpeed:        4.317,
    sprintSpeed:      5.612,
    followRange:      0,
    movementType:     'none' 
  },
  pathfinding: {
    enabled:          false,
    avoidWater:       true,
    avoidLava:        true,
    range:            32,
    maxFallDistance:  3,
    canOpenDoors:     true,
    canBreakBlocks:   false
  },
  advanced: {
    viewDistance:     4,
    chatDelay:        0,
    reconnectDelay:   5000,
    autoRespawn:      true,
    hideErrors:       false,
    colorChat:        true
  }
};

let users = {};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  }
  if (fs.existsSync(USERS_PATH)) {
    users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  } else {
    users = {
      admin: bcrypt.hashSync('admin', 10),
      user1: bcrypt.hashSync('password1', 10),
      user2: bcrypt.hashSync('password2', 10)
    };
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
  }
} catch (err) {
  console.error('Error loading config/users:', err);
}

let lastAFKCommand = null;
let bot = null;
let timers = [];
let isConnecting = false;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'your-secret-key-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } 
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  } else {
    return res.redirect('/login');
  }
}

io.use((socket, next) => {
  const session = socket.request.session;
  if (session && session.user) {
    next();
  } else {
    next(new Error('Authentication required'));
  }
});

app.use('/static', express.static('public'));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (users[username] && bcrypt.compareSync(password, users[username])) {
    req.session.user = username;
    res.redirect('/');
  } else {
    res.status(401).send('Invalid credentials');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function emitStatus() {
  const isConnected = bot && bot.entity ? true : false;
  const currentAccount = config.accounts[config.selectedAccount];
  
  io.emit('status', {
    accounts:           config.accounts.map(acc => ({ 
      username: acc.username, 
      auth: acc.auth 
    })),
    selectedAccount:    config.selectedAccount,
    connected:          isConnected,
    username:           isConnected ? bot.username : (currentAccount ? currentAccount.username : '—'),
    host:               config.host,
    port:               config.port,
    wiggleInterval:     config.wiggleInterval,
    wiggleAmplitude:    config.wiggleAmplitude,
    chatPingEnabled:    config.chatPingEnabled,
    chatPingInterval:   config.chatPingInterval,
    chatPingMessage:    config.chatPingMessage,
    afkRetryInterval:   config.afkRetryInterval,
    autoReconnect:      config.autoReconnect,
    physics:            config.physics,
    movement:           config.movement,
    pathfinding:        config.pathfinding,
    advanced:           config.advanced
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

const MINECRAFT_COLORS = {
  '0': '#000000', // Black
  '1': '#0000AA', // Dark Blue
  '2': '#00AA00', // Dark Green
  '3': '#00AAAA', // Dark Aqua
  '4': '#AA0000', // Dark Red
  '5': '#AA00AA', // Dark Purple
  '6': '#FFAA00', // Gold
  '7': '#AAAAAA', // Gray
  '8': '#555555', // Dark Gray
  '9': '#5555FF', // Blue
  'a': '#55FF55', // Green
  'b': '#55FFFF', // Aqua
  'c': '#FF5555', // Red
  'd': '#FF55FF', // Light Purple
  'e': '#FFFF55', // Yellow
  'f': '#FFFFFF', // White
  'r': 'reset'
};

const MINECRAFT_FORMATS = {
  'l': 'bold',
  'm': 'strikethrough',
  'n': 'underline',
  'o': 'italic',
  'k': 'obfuscated'
};

function parseMinecraftCodes(text) {
  let result = [];
  let currentStyle = {
    color: null,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    obfuscated: false
  };
  
  text = text.replace(/§/g, '&');
  
  let parts = text.split(/(&[0-9a-fklmnor])/);
  let currentText = '';
  
  for (let part of parts) {
    if (part.match(/^&[0-9a-fklmnor]$/)) {
      if (currentText) {
        result.push({
          text: currentText,
          style: {...currentStyle}
        });
        currentText = '';
      }
      
      const code = part[1];
      if (MINECRAFT_COLORS[code]) {
        if (code === 'r') {
          currentStyle = {
            color: null,
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            obfuscated: false
          };
        } else {
          currentStyle.color = MINECRAFT_COLORS[code];
        }
      } else if (MINECRAFT_FORMATS[code]) {
        currentStyle[MINECRAFT_FORMATS[code]] = true;
      }
    } else {
      currentText += part;
    }
  }
  
  if (currentText) {
    result.push({
      text: currentText,
      style: {...currentStyle}
    });
  }
  
  return result;
}

function log(msg) {
  if (config.advanced.colorChat) {
    const parsed = parseMinecraftCodes(msg);
    io.emit('colorLog', parsed);
  } else {
    io.emit('log', msg);
  }
  console.log(msg);
}

function clearTimers() {
  timers.forEach(clearInterval);
  timers = [];
}

async function getAuthUrl(account) {
  try {
    const authFlow = new msaAuth.MicrosoftOAuth();
    const data = await authFlow.getAuthCode();
    return { authCode: data.code, url: data.uri, account: account };
  } catch (err) {
    log(`❌ Failed to get auth URL: ${err.message}`);
    return null;
  }
}

let reconnectAttempts = 0;

function startBot() {
  if (isConnecting) return;
  if (bot) {
    bot.end();
    bot.removeAllListeners();
    bot = null;
  }
  clearTimers();

  if (config.accounts.length === 0) {
    log('⚠️ No accounts configured. Please add an account first.');
    return;
  }

  const account = config.accounts[config.selectedAccount] || config.accounts[0];
  isConnecting = true;
  
  try {
    bot = mineflayer.createBot({
      host:     config.host,
      port:     config.port,
      auth:     account.auth,
      username: account.username,
      version:  false, 
      checkTimeoutInterval: 60 * 1000,
      physicsEnabled: config.physics.jumpEnabled || config.physics.sprintEnabled || config.physics.sneakEnabled,
      viewDistance: config.advanced.viewDistance,
      hideErrors: config.advanced.hideErrors
    });

    bot.chat = (message) => {
      if (bot._client) {
        bot._client.write('chat_message', { message });
      }
    };

    bot.once('inject_allowed', () => {
      if (bot.physics) {
        bot.physics.gravity = config.physics.gravity;
        bot.physics.jumpBoost = config.physics.jumpBoost;
        bot.physics.waterSpeed = config.physics.waterSpeed;
        bot.physics.autoJump = config.movement.autoJump;
        bot.physics.autoJumpHeight = config.movement.autoJumpHeight;
      }
    });

    bot.once('spawn', () => {
      isConnecting = false;
      reconnectAttempts = 0; 
      
      log(`✔️ §aLogged in as §e${bot.username}`);
      emitStatus();

      if (config.autoReconnect.onJoinCommand) {
        const commands = config.autoReconnect.onJoinCommand.split(';');
        let delay = 1000;
        commands.forEach(cmd => {
          cmd = cmd.trim();
          if (cmd) {
            setTimeout(() => {
              bot.chat(cmd);
              log(`§6[AUTO] §f${cmd}`);
            }, delay);
            delay += 500; 
          }
        });
      }

      if (config.physics.jumpEnabled) {
        bot.setControlState('jump', false);
      }
      if (config.physics.sprintEnabled) {
        bot.setControlState('sprint', true);
      }
      if (config.physics.sneakEnabled) {
        bot.setControlState('sneak', true);
      }

      if (config.wiggleInterval > 0) {
        timers.push(setInterval(() => {
          if (bot.entity) {
            bot.look(bot.entity.yaw + config.wiggleAmplitude, bot.entity.pitch, false);
          }
        }, config.wiggleInterval));
      }

      if (config.chatPingEnabled && config.chatPingInterval > 0) {
        timers.push(setInterval(() => {
          if (bot && bot.chat) {
            bot.chat(config.chatPingMessage);
          }
        }, config.chatPingInterval));
      }

      if (config.movement.movementType === 'patrol') {
        timers.push(setInterval(() => {
          if (bot.entity) {
            const angle = Math.random() * Math.PI * 2;
            const distance = 5 + Math.random() * 5;
            const dx = Math.cos(angle) * distance;
            const dz = Math.sin(angle) * distance;
            const pos = bot.entity.position;
            bot.pathfinder?.goto(pos.offset(dx, 0, dz));
          }
        }, 10000));
      } else if (config.movement.movementType === 'random') {
        timers.push(setInterval(() => {
          if (bot.entity) {
            bot.setControlState('forward', Math.random() > 0.5);
            bot.setControlState('left', Math.random() > 0.7);
            bot.setControlState('right', Math.random() > 0.7);
          }
        }, 2000));
      }

      if (config.advanced.autoRespawn) {
        bot.on('death', () => {
          log('§c💀 Bot died, respawning...');
          setTimeout(() => {
            if (bot && !bot.entity) {
              bot.respawn();
            }
          }, 1000);
        });
      }
    });

    bot.on('message', msg => {
      const text = msg.toString();
      log(`[CHAT] ${text}`);
      
      if (text.toLowerCase().includes('region is full')) {
        log(`§e⚠️ Region full, retrying in ${config.afkRetryInterval}ms`);
        timers.push(setTimeout(() => {
          if (lastAFKCommand && bot && bot.chat) {
            bot.chat(lastAFKCommand);
          }
        }, config.afkRetryInterval));
      }
    });

    bot.on('kicked', reason => {
      log(`§c❌ Kicked: ${JSON.stringify(reason)}`);
      emitStatus();
      isConnecting = false;
      handleDisconnect();
    });

    bot.on('end', () => {
      log('§e⚠️ Disconnected');
      emitStatus();
      isConnecting = false;
      handleDisconnect();
    });

    bot.on('error', err => {
      log(`§c⚠️ Error: ${err.message}`);
      console.error(err);
      isConnecting = false;
      handleDisconnect();
    });
  } catch (err) {
    log(`§c❌ Failed to create bot: ${err.message}`);
    isConnecting = false;
    handleDisconnect();
  }
}

function handleDisconnect() {
  if (config.autoReconnect.enabled) {
    reconnectAttempts++;
    
    if (config.autoReconnect.maxAttempts === -1 || reconnectAttempts <= config.autoReconnect.maxAttempts) {
      log(`§6⟳ Auto reconnect attempt ${reconnectAttempts}${config.autoReconnect.maxAttempts === -1 ? '' : '/' + config.autoReconnect.maxAttempts} in ${config.autoReconnect.delay}ms...`);
      timers.push(setTimeout(startBot, config.autoReconnect.delay));
    } else {
      log(`§c❌ Max reconnect attempts (${config.autoReconnect.maxAttempts}) reached. Giving up.`);
    }
  }
}

io.on('connection', socket => {
  emitStatus();

  socket.on('addAccount', async data => {
    const authInfo = await getAuthUrl(data.username);
    if (authInfo) {
      socket.emit('authRequired', authInfo);
    }
  });

  socket.on('completeAuth', async data => {
    try {
      const authFlow = new msaAuth.MicrosoftOAuth();
      const result = await authFlow.getToken(data.authCode);
      
      config.accounts.push({
        username: data.account,
        auth: 'microsoft',
        msaToken: result.access_token,
        authFlow: authFlow
      });
      
      saveConfig();
      emitStatus();
      log(`✔️ Account ${data.account} added successfully`);
    } catch (err) {
      log(`❌ Failed to complete auth: ${err.message}`);
    }
  });

  socket.on('removeAccount', index => {
    if (index >= 0 && index < config.accounts.length) {
      const removed = config.accounts.splice(index, 1)[0];
      if (config.selectedAccount >= config.accounts.length) {
        config.selectedAccount = Math.max(0, config.accounts.length - 1);
      }
      saveConfig();
      emitStatus();
      log(`✔️ Removed account ${removed.username}`);
    }
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
    
    config.autoReconnect.enabled       = data.autoReconnectEnabled === 'on';
    config.autoReconnect.delay         = parseInt(data.autoReconnectDelay, 10);
    config.autoReconnect.onJoinCommand = data.autoReconnectOnJoinCommand;
    config.autoReconnect.maxAttempts   = parseInt(data.autoReconnectMaxAttempts, 10);
    
    config.physics.jumpEnabled     = data.physicsJumpEnabled === 'on';
    config.physics.sprintEnabled   = data.physicsSprintEnabled === 'on';
    config.physics.sneakEnabled    = data.physicsSneakEnabled === 'on';
    config.physics.gravity         = parseFloat(data.physicsGravity);
    config.physics.jumpBoost       = parseFloat(data.physicsJumpBoost);
    config.physics.waterSpeed      = parseFloat(data.physicsWaterSpeed);
    
    config.movement.autoJump       = data.movementAutoJump === 'on';
    config.movement.autoJumpHeight = parseFloat(data.movementAutoJumpHeight);
    config.movement.walkSpeed      = parseFloat(data.movementWalkSpeed);
    config.movement.sprintSpeed    = parseFloat(data.movementSprintSpeed);
    config.movement.movementType   = data.movementType;
    
    config.pathfinding.enabled     = data.pathfindingEnabled === 'on';
    config.pathfinding.avoidWater  = data.pathfindingAvoidWater === 'on';
    config.pathfinding.avoidLava   = data.pathfindingAvoidLava === 'on';
    config.pathfinding.canOpenDoors = data.pathfindingCanOpenDoors === 'on';
    
    config.advanced.autoRespawn    = data.advancedAutoRespawn === 'on';
    config.advanced.viewDistance   = parseInt(data.advancedViewDistance, 10);
    config.advanced.reconnectDelay = parseInt(data.advancedReconnectDelay, 10);
    config.advanced.colorChat      = data.advancedColorChat === 'on';

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

app.get('/manage-users', requireAuth, (req, res) => {
  if (req.session.user !== 'admin') {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'manage-users.html'));
});

app.get('/users', requireAuth, (req, res) => {
  if (req.session.user !== 'admin') {
    return res.status(403).send('Admin access required');
  }
  res.json(Object.keys(users));
});

app.post('/users', requireAuth, (req, res) => {
  if (req.session.user !== 'admin') {
    return res.status(403).send('Admin access required');
  }
  
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password required');
  }
  
  if (users[username]) {
    return res.status(400).send('User already exists');
  }
  
  users[username] = bcrypt.hashSync(password, 10);
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
  res.json({ success: true });
});

app.delete('/users/:username', requireAuth, (req, res) => {
  if (req.session.user !== 'admin') {
    return res.status(403).send('Admin access required');
  }
  
  const { username } = req.params;
  if (username === 'admin') {
    return res.status(400).send('Cannot delete admin user');
  }
  
  if (users[username]) {
    delete users[username];
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
    res.json({ success: true });
  } else {
    res.status(404).send('User not found');
  }
});

const WEB_PORT = 3000;
server.listen(WEB_PORT, () => {
  console.log(`UI at http://localhost:${WEB_PORT}`);
  console.log('Default users:');
  console.log('  admin / admin (administrator)');
  console.log('  user1 / password1');
  console.log('  user2 / password2');
  console.log('\nLogin to manage users and start the bot.');
  startBot();
});
