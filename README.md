# Remote-RED

Remote-RED is an ecosystem to bring remote access and push notifications to Node-RED. It consists of several parts:
- node-red-contrib-remote: The Node-RED nodes of Remote-RED. Published in this repro.
- Remote-RED servers: Several servers used for proxying the remote access traffic and sending push notifications.
- Remote-RED apps: Apps to access the services published by the Remote-RED remote-access node and receiving the push notifications of the remote-notification node. Available or Android, iOS and iPadOS.


## Installation of Node-RED nodes

You can install the Remote-RED nodes through the Node-RED library. Search for 'node-red-contrib-remote'.


## Remote-RED Apps

While the beta phase the apps will be available through Apple TestFlight and Google Closed Group Testing. Contact me to get the apps.


## Tutorial for Remote-RED

There is a help page describing how the the nodes work together and how to connect the apps.
[Help in English](https://www.remote-red.com/en/help/)
[Hilfe in deutsch](https://www.remote-red.com/de/hilfe/)


## Version History

Version 1.0.3:
- Added the function to activate verbose logging of the SSH tunnel.

Version 1.0.2:
- Added a button to create a support mail in the config node.

Version 1.0.1:
- Initial release
