# Remote-RED

Remote-RED is an ecosystem to bring remote access and push notifications to Node-RED. It consists of several parts:
- node-red-contrib-remote: The Node-RED nodes of Remote-RED. Published in this repro.
- Remote-RED servers: Several servers used for proxying the remote access traffic and sending push notifications.
- Remote-RED apps: Apps to access the services published by the Remote-RED remote-access node and receiving the push notifications of the remote-notification node. Available or Android, iOS and iPadOS.


## Installation of Node-RED nodes

You can install the Remote-RED nodes through the Node-RED library. Search for 'node-red-contrib-remote'.


## Remote-RED Apps

You can install them from the Google PlayStore or Apple AppStore:

[Remote-RED App for Android](http://play.google.com/store/apps/details?id=com.looking4cache.remotered.android)

[Remote-RED App for iOS](https://apps.apple.com/us/app/remote-red/id1529777665)


## Tutorial for Remote-RED

There is a help page describing how the the nodes work together and how to connect the apps.

[Help in English](https://www.remote-red.com/en/help/)

[Hilfe in deutsch](https://www.remote-red.com/de/hilfe/)


## Contact

You will find more information on [www.remote-red-com](https://www.remote-red.com). You can contact me by mail through info@remote-red.com.


## Version History

Version 1.2.2:
- Better Windows support: Using remote access with 'localhost' will not work on Windows 10 hosts. Now it uses '127.0.0.1' instead.

Version 1.2.1:
- Fixed a bug that texts was not shown (especially in the notification node).

Version 1.2.0:
- In iOS you can now use Shortcuts and in Android you can new use a widget to perform actions in Node-RED. This action will be emitted through the new output of the remote access node.

Version 1.1.3:
- The question node works now well after a new deploy. Before sometimes a Node-RED restart was required.
- The access node now reduces the ssh connection attempts if it fails to connect for a longer time.
- The notification and question node has a limit now. It limits the push notifications to 100 per hour and node.

Version 1.1.2:
- The question node now supports custom httpRoot paths, as it is used e.g. in RedMatic.

Version 1.1.1:
- Dependency update axios

Version 1.1.0:
- Added question node to send questions through push notifications. They can be answered directly on the notification level.
- You can select sounds for the push notifications.
- Important: Please update your mobile apps to Version 1.1.0 too.

Version 1.0.3:
- Added the function to activate verbose logging of the SSH tunnel.

Version 1.0.2:
- Added a button to create a support mail in the config node.

Version 1.0.1:
- Initial release
