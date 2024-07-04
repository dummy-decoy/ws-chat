const http = require('http');
const ws = require('ws');
const fs = require('fs');

class UserOptions {admin = false; bot = false};
class ChannelOptions {password = undefined; moderated = false; secret = false; topic = false};
class ChannelUserOptions {operator = false; voiced = true};

class User {
    url = '';
    nick = undefined;
    options = new UserOptions();
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
    options = new ChannelOptions();
    users = new Map();

    constructor(name) {
        this.name = name;
    };
};

class Chat {
    motd = 'Welcome to the server !';
    users = new Set();
    channels = new Map();
    
    _joinChannel(user, channel) {
        let joined = this.channels.get(channel);
        if (!joined) {
            joined = new Channel(channel);
            joined.users.set(user, {...new ChannelUserOptions(), operator:true});
            this.channels.set(channel, joined);
        } else { 
            joined.users.set(user, {...new ChannelUserOptions(), 'voiced': !joined.options.moderated});
        }
        for (let [dest, options] of joined.users) { dest.handler.get('join')(user.nick, joined.name); };
        return joined;
    }
    _cleanupChannel(user, channel) {
        channel.users.delete(user);
        if (channel.users.size == 0)
            this.channels.delete(channel.name);
    }
    _leaveChannel(user, channel, reason) {
        for (let [dest, options] of channel.users) { dest.handler.get('leave')(user.nick, channel.name, reason); };
        this._cleanupChannel(user, channel);
    };
    _kickUser(user, channel, reason) {
        for (let [dest, options] of channel.users) { dest.handler.get('kick')(user.nick, channel.name, reason); };
        this._cleanupChannel(user, channel);
    }
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
        return (typeof reason == 'undefined') || ((reason.length <= 50) && (/^[^\f\n\r\v]+$/.test(reason)));
    };

    connect(host, port) {
        let user = new User(`${host}:${port}`);
        this.users.add(user);
        console.log(`${user.nick}@${user.url} connected`);
        return user;
    };
    disconnect(user, reason) {
        console.log(`${user.nick}@${user.url} is quitting (${reason})`);
        for (let channel of user.channels.values())
            this._leaveChannel(user, channel, `${user.nick} has left the building !`);
        this.users.delete(user);
    };

    timeq(user) {
        user.handler.get('time')(Date().toString());
    };
    motdq(user, value=undefined) {
        if (typeof value === 'undefined') {
            user.handler.get('motd')(this.motd);
        } else {
            if (!user.options.admin)
                return user.handler.get('error')('you are not allowed to modify server motd');
            this.motd = value;
            for (let dest of this.users) { dest.handler.get('motd')(this.motd) };
        }
    };
    nickq(user, newnick) {
        if (!this._validateNick(newnick))
            return user.handler.get('error')('invalid nick (max 25 letters, does not contain whitespace nor @ # & !)');
        let oldnick = user.nick;
        user.nick = newnick;
        user.handler.get('nick')(newnick);
        for (let channel of user.channels) { channel.users.forEach(function (options,dest) {dest.handler.get('nick')(newnick, oldnick, channel.name);}) };
    };
    listq(user) {
        user.handler.get('list')(Array.from(Array.from(this.channels.values()).filter((channel) => user.options.admin || user.channels.has(channel.name) || !channel.options.secret).map((channel) => [channel.name, {...channel.options, password: !!channel.options.password}])));
    };
    usersq(user, channel = undefined) {
        if (typeof channel == 'undefined') {
            if (!user.options.admin)
                return user.handler.get('error')('insufficient privileges');
            user.handler.get('users')(undefined, Array.from(this.users).map(user => [user.nick,user.options,user.url]));
        } else {
            if (!user.channels.has(channel))
                return user.handler.get('error')(`not participating in channel ${channel}`);
            user.handler.get('users')(channel, Array.from(this.channels.get(channel).users).map(([user,options]) => [user.nick, {...user.options,...options},user.url]));
        }
    };
    joinq(user, channel, password=undefined) {
        if (!this._validateChannel(channel))
            return user.handler.get('error')('invalid name for a channel (max 25 letters, does not contain whitespace nor @ # & !)');
        if (!user.nick)
            return user.handler.get('error')('please choose your nickname first');
        if (user.channels.has(channel))
            return user.handler.get('error')(`channel ${channel} already joined`);
        if (this.channels.has(channel) && this.channels.get(channel).options.password && (this.channels.get(channel).options.password != password) && !user.options.admin)
            return user.handler.get('error')(`a password is required to join channel ${channel}`);
        let joined = this._joinChannel(user, channel);
        user.channels.set(channel, joined);
        this.usersq(user, channel);
        this.topicq(user, channel);
    };
    topicq(user, channel, value=undefined) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        if (typeof value == 'undefined') {
            return user.handler.get('topic')(channel, this.channels.get(channel).topic);
        } else {
            let target = this.channels.get(channel);
            if (target.options.topic && !channel.users.get(user).options.operator)
                return user.handler.get('error')('you are not allowed to modify channel topic');
            if (!this._validateTopic(value))
                return user.handler.get('error')('invalid topic (max 200 letters)');
            target.topic = value;
            for (let dest of target.users.keys()) { dest.handler.get('topic')(channel, value); };
        }
    };
    msgq(user, channel, message) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        let target = this.channels.get(channel);
        if (target.options.moderated && !target.users.get(user).operator && !target.users.get(user).voiced && !user.options.admin)
            return user.handler.get('error')('you are not allowed to talk');
        if (!this._validateMessage(message))
            return user.handler.get('error')('invalid message (max 1000 characters)');
        for (let dest of target.users.keys()) { dest.handler.get('msg')(user.nick, channel, message); };
    };
    privmsgq(user, target, message) {
        if (!user.nick)
            return user.handler.get('error')('please choose your nickname first');
        let findUser = (nick) => {
            for (let user of this.users.keys()) if (user.nick == nick) return user;
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
    channelmodeq(user, channel, options) {
        if (!this.channels.has(channel))
            return user.handler.get('error')(`channel ${channel} does not exist`);
        let target = this.channels.get(channel);
        if (typeof options == 'undefined') {
            if (target.options.secret && !user.channels.has(channel) && !user.options.admin)
                return user.handler.get('error')(`channel ${channel} does not exist`);
            user.handler.get('channelmode')(channel, {...target.options, password: !!target.options.password});
        } else {
            if (!target.users.has(user) && !target.users.get(user).operator && !user.options.admin)
                return user.handler.get('error')('you are not allowed to change channel modes');
            // do not trust user input to store those permissions
            if ('topic' in options) target.options.topic = !!options.topic;
            if ('moderated' in options) target.options.moderated = !!options.moderated;
            if ('secret' in options) target.options.secret = !!options.secret;
            if ('password' in options) { if (!options.password) target.options.password = undefined; else target.options.password = options.password; };
            for (let dest of target.users.keys()) { dest.handler.get('channelmode')(channel, {...target.options, password: !!target.options.password}); };
            if (!user.channels.has(channel)) user.handler.get('channelmode')(channel, {...target.options, password: !!target.options.password});
        }
    };
    chanusermodeq(user, channel, victim, options) {
        if (!this.channels.has(channel))
            return user.handler.get('error')(`channel ${channel} does not exist`);
        let target = this.channels.get(channel);
        let findUser = (nick) => {
            for (let user of this.users.keys()) if (user.nick == nick) return user;
            return undefined;
        }
        let dest = findUser(victim);
        if (typeof dest === 'undefined')
            return user.handler.get('error')(`user ${victim} not found`);
        if (!dest.channels.has(channel))
            return user.handler.get('error')(`user ${victim} does not participate in channel ${channel}`);
        if (typeof options == 'undefined') {
            if (target.options.secret && !user.channels.has(channel) && !user.options.admin)
                return user.handler.get('error')(`channel ${channel} does not exist`);
            user.handler.get('chanusermode')(channel, victim, {...target.users.get(dest), ...dest.options});
        } else {
            if (!target.users.has(user) && !target.users.get(user).operator && !user.options.admin)
                return user.handler.get('error')('you are not allowed to change user modes on this channel');
            // do not trust user input to store those permissions
            if ('operator' in options) target.users.get(dest).operator = !!options.operator;
            if ('voiced' in options) target.users.get(dest).voiced = !!options.voiced;
            for (let peon of target.users.keys()) { peon.handler.get('chanusermode')(channel, victim, target.users.get(dest)); };
            if (!user.channels.has(channel)) user.handler.get('chanusermode')(channel, victim, target.users.get(dest));
        }
    };
    usermodeq(user, victim, options) {
        let findUser = (nick) => {
            for (let user of this.users.keys()) if (user.nick == nick) return user;
            return undefined;
        }
        let dest = findUser(victim);
        if (typeof dest === 'undefined')
            return user.handler.get('error')(`user ${victim} not found`);
        if (typeof options == 'undefined') {
            user.handler.get('usermode')(dest.nick, dest.options);
        } else {
            if (('admin' in options) && !user.options.admin)
                return user.handler.get('error')('insufficient privileges');
            if (('bot' in options) && !user.options.admin && (user != dest))
                return user.handler.get('error')('you cannot make other people feel like a bot !');
            // do not trust user input to store those permissions
            if ('admin' in options) dest.options.admin = !!options.admin;
            if ('bot' in options) dest.options.bot = !!options.bot;
            dest.handler.get('usermode')(dest.nick, dest.options);
            if (user != dest) user.handler.get('usermode')(dest.nick, dest.options);
        }
    };
    kickq(user, channel, victim, reason) {
        if (!user.channels.has(channel))
            return user.handler.get('error')(`not participating in channel ${channel}`);
        if (!user.channels.get(channel).users.get(user).operator && !user.options.admin)
            return user.handler.get('error')(`you have no right to kick ${victim} out of ${channel}`);
        let findUser = (nick) => {
            for (let user of this.users.keys()) if (user.nick == nick) return user;
            return undefined;
        }
        let dest = findUser(victim);
        if (typeof dest === 'undefined')
            return user.handler.get('error')(`user ${victim} not found`);
        if (!dest.channels.has(channel))
            return user.handler.get('error')(`user ${victim} is not guilty of anything in channel ${channel}`);
        if (!this._validateReason(reason))
            return user.handler.get('error')('invalid reason (max 50 characters)');
        let kicked = user.channels.get(channel);
        this._kickUser(dest, kicked, reason);
        dest.channels.delete(channel);
    };
    killq(user, victim, reason) {
        if (!user.options.admin)
            return user.handler.get('error')('there is no such thing as free kill !');
        let findUser = (nick) => {
            for (let user of this.users.keys()) if (user.nick == nick) return user;
            return undefined;
        }
        let dest = findUser(victim);
        if (typeof dest === 'undefined')
            return user.handler.get('error')(`user ${victim} not found`);
        if (!this._validateReason(reason))
            return user.handler.get('error')('invalid reason (max 50 characters)');
        this._kickUser(dest, reason);
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
        user.on('channelmode', this.channelmode.bind(ws));
        user.on('chanusermode', this.chanusermode.bind(ws));
        user.on('usermode', this.usermode.bind(ws));
        user.on('kick', this.kick.bind(ws));
        user.on('kill', this.kill.bind(ws));

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
                    chat.motdq(user, (message[1] && ('value' in message[1])) ? message[1].value : undefined);
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
                    chat.usersq(user, (message[1] && ('channel' in message[1])) ? message[1].channel : undefined);
                    break;
                case 'join':
                    chat.joinq(user, message[1].channel, 'password' in message[1] ? message[1].password : undefined);
                    break;
                case 'mode':
                    if ('channel' in message[1]) {
                        if ('user' in message[1])
                            chat.chanusermodeq(user, message[1].channel, message[1].user, 'options' in message[1] ? message[1].options : undefined);
                        else
                            chat.channelmodeq(user, message[1].channel, 'options' in message[1] ? message[1].options : undefined);
                    } else {
                        chat.usermodeq(user, message[1].user, 'options' in message[1] ? message[1].options : undefined)
                    };
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
                case 'kick':
                    chat.kickq(user, message[1].channel, message[1].user, 'reason' in message[1] ? message[1].reason : undefined);
                    break;
                case 'kill':
                    chat.killq(user, message[1].user, 'reason' in message[1] ? message[1].reason : undefined);
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
    channelmode(channel, options) {
        this.send(JSON.stringify(['mode', {'channel': channel, 'options': options}]))
    };
    chanusermode(channel, user, options) {
        this.send(JSON.stringify(['mode', {'channel': channel, 'user': user, 'options': options}]));
    };
    usermode(user, options) {
        this.send(JSON.stringify(['mode', {'user': user, 'options': options}]));
    };
    kick(user, channel, reason) {
        this.send(JSON.stringify(['kick', {'user': user, 'channel': channel, 'reason': reason}]));
    };
    kill(user, reason) {
        this.send(JSON.stringify(['kill', {'user': user, 'reason': reason}]));
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
