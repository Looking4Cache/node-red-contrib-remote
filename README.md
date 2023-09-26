# Remote-RED

Remote-RED is an ecosystem to bring remote access, push notification and geofencing to Node-RED. There are also additional functions like directly answer on a notification and homescreen widgets. It consists of several parts:
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

[Hilfe in Deutsch](https://www.remote-red.com/de/hilfe/)


## Contact

You will find more information on [www.remote-red-com](https://www.remote-red.com). You can contact me by mail through info@remote-red.com.


## Version History

Version 1.5.1
- Added support for running Node-RED with a self signed https certificate.
- Notifications and Questions will automatically convert values to string if a string is needed (e.g. title and body). 

Version 1.5.0
- Geofencing! You can add geofences in the apps. Entering and leaving them will trigger a message on the new output of the remote access node.
- Adding server location in Asia.
- New instances will have the base url '/ui' again.
- Error with "Multiple requests" after a missing internet connection fixed.
- iOS App: Links with target '_blank' will be redirected to iOS.

Version 1.4.0
- In addition to the QR code, a link is now generated to add an instance in the app.
- Sending notifications and questions is prevented if msg.playload.send === false.
- Error catched if a notification or question does not contain a title and body.

Version 1.3.3:
- Improved compatibility for Windows.

Version 1.3.2:
- Changed the method to get the installed node version. Thanks hardillb!

Version 1.3.1:
- Added timeout handling to the heartbeat function.
- Catches errors when evaluating the title, body or sound of an notification.

Version 1.3.0:
- A heartbeat function is added to the remote access node. This will automatically reconnect if the connection is interrupted, e.g. due to an unstable internet connection.

Version 1.2.3:
- The settings base url and port are filled automatically for new config nodes. This is helpful when using alternative installations such as RedMatic.
- Notifications and Questions can have a computed sound. So you can include the sound based on the incoming message.
- Notifications and Questions without an body or an title will not be send to the Remote-RED servers.
- Logs an error message if a notification or question exceeds the size of 3600 bytes.

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
