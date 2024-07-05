# ws-chat
An IRC like online chat running in your web browser using WebSockets

## Running the chat server

The chat server runs with node.js. After [installing node](https://nodejs.org/en/download/package-manager), execute the server by typing on a command line:

> `node server.js`

The server listens to **port 80** by default. However, you can change this port on the command line:

> `node server.js 5000`

You can now open a browser and browse to the url of the server, the server will display the client interface.

## Using the chat

Command help:

> **/help** : show the help message  
> **/connect <host:port>** : connect to a chat server  
> **/motd** : display the server message of the day  
> **/motd <message>** : set the server message of the day (requires: admin)  
> **/time** : show the server local time  
> **/nick <nickname>** : set the nickname you will be yelled at  
> **/list** : list all channels on this server  
> **/users** : list all users on the server (requires: admin)  
> **/users <#channel>** : list all users on the specified channel. you must have joined the channel to see the list  
> **/join <#channel> [<password>]** : join a channel and participate ! if the channel does not exist, it is automatically created.  
> **/topic <#channel>** : show the current topic of the specified channel  
> **/topic <#channel> <topic...>** : set the topic of the specified channel  
> **/msg <#channel> <message...>** : send a message to the specified channel  
> **/msg <@user> <message...>** : send a private message to the specified user  
> **/leave <#channel> [<reason>]** : leave the channel. the channel is automatically destroyed when the last particiapnt leaves  
> **/mode <#channel>** : query modes for this channel  
> **/mode <#channel> [+|- <channel modes>] [<password>]** : set modes for this channel  
> **/mode <#channel> <@user>&nbsp[+|- <channel user modes>]** : set modes for this user on this channel  
> **/mode <@user>&nbsp[+|- <user modes>]** : set global modes for this user  
> **/kick <#channel> <@user> [<reason>]** : kick a user out of a channel (requires: operator, admin)  
> **/select <#channel>** : makes the specified channel the active channel. everything you type in the input box will be sent to this channel  

Channel modes are:

> **s :** : *secret*. the channel does not appear when listing channels with the /list command (except for server admnistrators)  
> **m :** : *moderated*. only users with the +v mode enabled can talk to the channel  
> **t :** : *limited topic*. only channel operators can change the topic of the channel  
> **k :** :  *password (key) protected*. the channel is only accessible to people knowing the password  

Channel specific user modes are:

> **o :** : *operator*. operators have super powers onto a channel  
> **v :** : *voiced*. voiced people are allowed to talk on moderated channels  

User modes are:
> **a :** : *admin*. server administrator, better not mess with them  
> **b :** : *bot*. complacency flag to signal a user is a bot  
