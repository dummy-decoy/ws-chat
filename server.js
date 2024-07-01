const http = require('http');
const ws = require('ws');
const fs = require('fs');


class User {
    url = '';
    nick = undefined;
    mode = 0;
    channels = new Map();
    handler = new Map();

    constructor(url) {
        this.url = url;
    };
    on(message, action) {
        this.handler.set(message, action);
    };
};

class Channel {
    name = '';
    topic = '';
    mode = 0;
    users = new Set();

    constructor(name) {
        this.name = name;
    };
};

class Chat {
    motd = 'Welcome to the server !';
    users = new Set();
    channels = new Map();
    
    _leaveChannel(user, channel, reason) {
        channel.users.forEach(function (dest) {dest.handler.get('leave')(user.nick, channel.name, reason);});
        channel.users.delete(user);
        if (channel.users.size == 0) {
            this.channels.delete(channel.name);
        }
    };
    _validateNick(nick) {
        return (nick.length <= 25) && (/^[^@#&!\s]+$/.test(nick));
    };
    _validateChannel(channel) {
        return (channel.length <= 25) && (/^[^@#&!\s]+$/.test(channel));
    };
    _validateTopic(topic) {
        return (topic.length <= 200) && (/^[^\f\n\r\v]+$/.test(topic));
    };
    _validateMessage(message) {
        return (message.length <= 1000) && (/^[^\f\n\r\v]+$/.test(message));
    };
    _validateReason(reason) {
        return (reason.length <= 50) && (/^[^\f\n\r\v]+$/.test(reason));
    };

    connect(host, port) {
        let user = new User(`${host}:${port}`);
        this.users.add(user);
        console.log(`${user.nick}@${user.url} connected`);
        return user;
    };
    disconnect(user, reason) {
        console.log(`${user.nick}@${user.url} is quitting (${reason})`);
        for (let channel of user.channels.values()) {
            this._leaveChannel(user, channel, `${user.nick} has left the building !`);
        }
        this.users.delete(user);
    };

    timeq(user) {
        user.handler.get('time')(Date().toString());
    };
    motdq(user) {
        user.handler.get('motd')(this.motd);
    };
    nickq(user, newnick) {
        if (!this._validateNick(newnick))
            return user.handler.get('error')('invalid nick (max 25 letters, does not contain whitespace nor @ # & !)');
        let oldnick = user.nick;
        user.nick = newnick;
        user.handler.get('nick')(newnick);
        user.channels.forEach(function (channel) {channel.users.forEach(function (dest) {dest.handler.get('nick')(newnick, oldnick, channel.name);})});
    };
    listq(user) {
        user.handler.get('list')(Array.from(this.channels.keys()));
    };
    usersq(user, channel) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        user.handler.get('users')(channel, Array.from(this.channels.get(channel).users).map(user=>user.nick));
    };
    joinq(user, channel) {
        if (!this._validateChannel(channel))
            return user.handler.get('error')('invalid name for a channel (max 25 letters, does not contain whitespace nor @ # & !)');
        if (user.channels.has(channel))
            return user.handler.get('error')(`channel ${channel} already joined`);
        if (!this.channels.has(channel))
            this.channels.set(channel, new Channel(channel));
        let joined = this.channels.get(channel);
        joined.users.add(user);
        user.channels.set(channel, joined);
        joined.users.forEach(function (dest) {dest.handler.get('join')(user.nick, joined.name);});
        this.usersq(user, channel);
        this.topicq(user, channel);
    };
    topicq(user, channel, value=undefined) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        if (typeof value === 'undefined') {
            user.handler.get('topic')(channel, this.channels.get(channel).topic);
        } else {
            if (!this._validateTopic(value))
                return user.handler.get('error')('invalid topic (max 200 letters)');
            this.channels.get(channel).topic = value;
            this.channels.get(channel).users.forEach(function (dest) {dest.handler.get('topic')(channel, value)});
        }
    }
    msgq(user, channel, message) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        if (!this._validateMessage(message))
            return user.handler.get('error')('invalid message (max 1000 characters)');
        this.channels.get(channel).users.forEach(function (dest) {dest.handler.get('msg')(user.nick, channel, message);});
    };
    privmsgq(user, target, message) {
        let findUser = (nick) => {
            for (let user of this.users) if (user.nick == nick) return user;
            return undefined;
        }
        let dest = findUser(target);
        if (typeof dest === 'undefined')
            user.handler.get('error')(`user ${target} not found`);
        else {
            if (!this._validateMessage(message))
                return user.handler.get('error')('invalid message (max 1000 characters)');
            user.handler.get('privmsg')(user.nick, target, message);
            dest.handler.get('privmsg')(user.nick, target, message);
        }
    }
    leaveq(user, channel, reason) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        if (!this._validateReason(reason))
            return user.handler.get('error')('invalid reason (max 50 characters)');
        let leaved = user.channels.get(channel);
        this._leaveChannel(user, leaved, reason);
        user.channels.delete(channel);
    };
};
var chat = new Chat();

class Protocol {
    connections = new Map();

    connect(ws) {
        console.log(`client connected: ws://${ws.host}:${ws.port}. ${this.connections.size+1} clients`);

        let user = chat.connect(ws.host, ws.port);
        this.connections.set(ws, user);
        
        user.on('error', this.error.bind(ws));
        user.on('time', this.time.bind(ws));
        user.on('motd', this.motd.bind(ws));
        user.on('nick', this.nick.bind(ws));
        user.on('list', this.list.bind(ws));
        user.on('users', this.users.bind(ws));
        user.on('join', this.join.bind(ws));
        user.on('topic', this.topic.bind(ws));
        user.on('msg', this.msg.bind(ws));
        user.on('privmsg', this.privmsg.bind(ws));
        user.on('leave', this.leave.bind(ws));

        this.version.bind(ws)();
        chat.motdq(user);
    };
    disconnect(ws, reason) {
        chat.disconnect(this.connections.get(ws), reason);
        this.connections.delete(ws);
        console.log(`client disconnected: ws://${ws.host}:${ws.port} (${reason}). ${this.connections.size} clients left`);
    };
    message(ws, data) {
        console.log(`received from ws://${ws.host}:${ws.port}: ${data}`);

        try {
            let user = this.connections.get(ws);
            let message = JSON.parse(data);
            
            switch (message[0]) {
                case 'version':
                    if ((message[1].protocol === 'ws') && (message[1].version === '1.0'))
                        this.version.bind(ws)();
                    else
                        this.error.bind(ws)('unrecognized protocol version');
                    break;
                case 'motd':
                    chat.motdq(user);
                    break;
                case 'time':
                    chat.timeq(user);
                    break;
                case 'nick':
                    chat.nickq(user, message[1].new);
                    break;
                case 'list':
                    chat.listq(user);
                    break;
                case 'users':
                    chat.usersq(user, message[1].channel);
                    break;
                case 'join':
                    chat.joinq(user, message[1].channel);
                    break;
                case 'topic':
                    chat.topicq(user, message[1].channel, 'value' in message[1] ? message[1].value : undefined);
                    break;
                case 'msg':
                    if ('channel' in message[1])
                        chat.msgq(user, message[1].channel, message[1].content);
                    else
                        chat.privmsgq(user, message[1].user, message[1].content);
                    break;
                case 'leave':
                    chat.leaveq(user, message[1].channel, 'reason' in message[1] ? message[1].reason : undefined);
                    break;
            }
        } catch (error) {
            console.log(error);
            this.error.bind(ws)('protocol error');
        }
    }

    error(message) {
        this.send(JSON.stringify(['error', {'message': message}]));
    }
    version() {
        this.send(JSON.stringify(['version', {'protocol': 'ws', 'version': '1.0'}]));
    };
    time(time) {
        this.send(JSON.stringify(['time', {'local': time}]));
    }
    motd(content) {
        this.send(JSON.stringify(['motd', {'content': content}]));
    };
    nick(newnick, oldnick, channel=undefined) {
       this.send(JSON.stringify(['nick', {'channel': channel, 'old': oldnick, 'new': newnick}]));
    };
    list(channels) {
        this.send(JSON.stringify(['list', {'channels': channels}]));
    };
    users(channel, users) {
        this.send(JSON.stringify(['users', {'channel': channel, 'users': users}]));
    }
    join(user, channel) {
        this.send(JSON.stringify(['join', {'user': user, 'channel': channel}]));
    };
    topic(channel, value) {
        this.send(JSON.stringify(['topic', {'channel': channel, 'value': value}]));
    };
    msg(sender, channel, content) {
        this.send(JSON.stringify(['msg', {'from': sender, 'channel': channel, 'content': content}]));
    };
    privmsg(sender, target, content) {
        this.send(JSON.stringify(['msg', {'from': sender, 'user': target, 'content': content}]));
    };
    leave(user, channel, reason) {
        this.send(JSON.stringify(['leave', {'user': user, 'channel': channel, 'reason': reason}]));
    };
};
var protocol = new Protocol();


const host = '0.0.0.0';
const port = process.argv[2] || 80;

const server = http.createServer(function (req, res) {
    fs.readFile('./client.html', function (err, data) {
        if (err) {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('404: File not found');
        } else {
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        }
    });
});

const wss = new ws.WebSocketServer({server: server});
wss.on('connection', function (ws,req) {
    ws.on('close', function (code, reason) {
        protocol.disconnect(this, reason);
    });
    ws.on('message', function (data) {
        protocol.message(this, data);
    });

    ws.host = req.socket.remoteAddress;
    ws.port = req.socket.remotePort;
    protocol.connect(ws);
});

server.listen(port, host, function () {
    console.log(`ws-chat http server running on http://${host}:${port}`);
});
