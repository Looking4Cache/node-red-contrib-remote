# Remote-RED

Remote-RED is an ecosystem to bring remote access and push notifications to Node-RED. It consists of several parts:
- node-red-contrib-remote: The Node-RED nodes of Remote-RED. Published in this repro.
- Remote-RED servers: Several servers used for proxying the remote access traffic and sending push notifications.
- Remote-RED apps: Apps to access the services published by the Remote-RED remote-access node and receiving the push notifications of the remote-notification node. Available or Android, iOS and iPadOS.

Remote-RED is currently in it´s initial beta testing phase.


## Installation of Node-RED nodes

While the beta phase it will not be available through the Node-RED library. So you have to ssh to your Node-RED computer and follow these steps:
- Goto your Node-RED directory, normally 'cd ~/.node-red'
- Install through NPM: 'npm install node-red-contrib-remote'
- Restart Node-RED, like 'service nodered restart' or 'pm2 restart node-red'


## Remote-RED Apps

While the beta phase the apps will be available through Apple TestFlight and Google Closed Group Testing. Contact me to get the apps.


## Tutorial for Remote-RED

There is a help page describing how the the nodes work together and how to connect the apps.
[Help in English](https://www.remote-red.com/en/help/)
[Hilfe in deutsch](https://www.remote-red.com/de/hilfe/)
