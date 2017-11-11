const functions = require('firebase-functions');
var dotenv = require('dotenv');
var firebaseAdmin = require("firebase-admin");
var algoliasearch = require('algoliasearch');
var firebase = require('firebase');
var GeoFire = require('geofire');
var shortid = require('shortid');
const hmac_sha256 = require('crypto-js/hmac-sha256');
const request = require('request');
var moment = require('moment-timezone');



const algoliaFunctions = require('algolia-firebase-functions-geoloc');

var config ={
    apiKey: "AIzaSyD5-GtfArEanLasYBxACCsKZCAwX_lQp3I",
    authDomain: "atiempo-5533e.firebaseapp.com",
    databaseURL: "https://atiempo-5533e.firebaseio.com",
    projectId: "atiempo-5533e",
    storageBucket: "atiempo-5533e.appspot.com",
    messagingSenderId: "212855483806"
  };
firebase.initializeApp(config);

// load values from the .env file in this directory into process.env
dotenv.load();

const algolia = algoliasearch(functions.config().algolia.app,
                              functions.config().algolia.key);
const indexProducts = algolia.initIndex(functions.config().algolia.index);
const indexShops = algolia.initIndex('shops');

var serviceAccount = require("./serviceAccountKey.json");
//firebaseAdmin.initializeApp(functions.config().firebase);
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount),
  databaseURL: "https://atiempo-5533e.firebaseio.com/"
});
var database = firebaseAdmin.database();

exports.syncAlgoliaWithFirebaseProducts = functions.database.ref("/products/{childRef}").onWrite((event) => {
    const data = event;
    var key = event.key;
    data.objectID = key;
    return algoliaFunctions.syncAlgoliaWithFirebase(indexProducts, data);
});

exports.syncAlgoliaWithFirebaseShops = functions.database.ref("/commerces/{childRef}").onWrite((event) => {
  let data = event;
  data.objectID = event.key;
  if(event.data.val() != null){
    if(event.data.val().lat != undefined && event.data.val().lng != undefined){
      data._geoloc = {
        lat: event.data.val().lat,
        lng: event.data.val().lng
      }
      let location = [event.data.val().lat, event.data.val().lng]
      let ref = firebase.database().ref('/commercesLocations').ref;
      let geoFire = new GeoFire(ref);
      geoFire.set(event.data.key, location)
    }
  }
  
  return algoliaFunctions.syncAlgoliaWithFirebase(indexShops, data);
});
exports.syncAlgolia = functions.https.onRequest((req, res) => {
  firebase.database().ref('/commerces').on('value',(ss)=>{
    ss.forEach(commerce =>{
      let data = {};
      data.name = commerce.val().name;
      data.description = commerce.val().description;
      data.objectID = commerce.key;
      data._geoloc = {
        lat: commerce.val().lat,
        lng: commerce.val().lng
      };
      indexShops.addObject(data);
    })
    res.status(200).send(ss) 
  });
});


exports.newOrderNotification = functions.database.ref('/orders/{order}').onWrite(event => {
	let orderData = event.data.val(); 
  let orderKey= event.data.key;
   let tokens = [];
   let commerceTocken;
   let adminTocken;
  if (!event.data.previous.exists()) {
		// Do things here if project didn't exists before
	}
  let order = event.params.order;

  firebase.database().ref('commerces/'+ orderData.commerceId).once("value").then( commerce=>{

    if(commerce.val() != null){
      commerceTocken = commerce.val().gcmTocken;
    }
    
    firebase.database().ref('admin').once("value").then( admin=>{
      adminTocken = admin.val().gcmTocken;
    }).then(h =>{

    if(commerce.val() != null){
      for(let key in commerceTocken){
        tokens.push(commerceTocken[key])
      }
    }
    for(let key1 in adminTocken){
      tokens.push(adminTocken[key1]);
    }
    let payload = {
              notification: {
                  title: 'NUEVA ORDEN',
                  body: "Tienes una nueva orden en proceso",
                  sound: 'default',
                  badge: '1'
              }, 
              data:{
                orderKey: orderKey
              }
          };

    return firebaseAdmin.messaging().sendToDevice(tokens, payload);
    firebaseAdmin.auth().createCustomToken()
  });
  });


});



exports.newOrder2 = functions.database.ref('/orders/{order}').onWrite(event => {
  let orderData = event.data.val(); 
  let ref = event.data.adminRef.parent.parent.child('/items_locations');
  firebase.database().ref('commerces/'+ orderData.commerceId).once("value").then( commerce=>{
    let location = [parseFloat(commerce.val().lat).toFixed(2), parseFloat(commerce.val().lng).toFixed(2)];
    let geoFire = new GeoFire(ref);
    geoFire.set('location',location);
  });
});

exports.getCustomToken = functions.https.onRequest((req, res) => {
  const accessToken = req.query.access_token || '';
  const facebookAppSecret = functions.config().facebook.app_secret;
  console.log(functions.config().facebook.app_secret);
  const appSecretProof = hmac_sha256(accessToken, facebookAppSecret).toString();
  console.log(appSecretProof);

  // validate Facebook Account Kit access token
  // https://developers.facebook.com/docs/accountkit/graphapi
  request({
      url: `https://graph.accountkit.com/v1.1/me/?access_token=${accessToken}`,
      json: true
  }, (error, fbResponse, data) => {
      if (error) {
          console.error('Access token validation request failed\n', error);
          res.status(400).send(error);
      } else if (data.error) {
          console.error('Invalid access token\n', 
              `access_token=${accessToken}\n`, 
              `appsecret_proof=${appSecretProof}\n`, 
              data.error);
          res.status(400).send(data);
      } else {
          firebaseAdmin.auth().createCustomToken(data.id)
              .then(customToken => res.status(200).send(customToken))
              .catch(error => {
                  console.error('Creating custom token failed:', error);
                  res.status(400).send(error);
              })
      }
  });
});
// Listen to HTTP Request to get Avalible commerces
exports.getCommerces = functions.https.onRequest((req, res) => {
  let category = req.query.category || '';
  let lat = Number(req.query.lat);
  let lng = Number(req.query.lng);
  let distance = Number(req.query.max_distance);
  let ref = firebase.database().ref('/commercesLocations').ref;
  let commerceIdA = [];

  let geoFire = new GeoFire(ref);
  let geoQuery = geoFire.query({
    center: [lat, lng],
    radius: distance
  });

  geoQuery.on("key_entered", (commerceId)=>{
    commerceIdA.push(commerceId);
  });

  onReady(geoQuery).then(()=>{
    getCommerces(commerceIdA, category, lat, lng).then(shopsListData=>{
      res.status(200).send(shopsListData);
    });
  });
});

exports.createCommerceLocation =functions.database.ref('/commerces/{commerce}').onWrite(event => {
  let commerceData = event.data.val(); 
  
      if(commerceData.lat != undefined && commerceData.lng != null){
        let location = [commerceData.lat, commerceData.lng]
        let ref = firebase.database().ref('/commercesLocations').ref;
        let geoFire = new GeoFire(ref);
        geoFire.set(event.params.contentId, location); 
      }

});

// Function to create a new order
exports.createNewOrder = functions.https.onRequest((req, res) => {
  let orderId = shortid.generate();
  let time = moment().tz("America/Bogota");
  console.log('Body: ', req.body);
  let bodyS;
  let body;
  if(req.body.data == undefined){
    bodyS= JSON.stringify(req.body);
    console.log('BodyS: ', bodyS);
    body = JSON.parse(bodyS);
    console.log('Body Final: ',body);
  }else{
    body = JSON.parse(req.body.data);
  }
  console.log('Body Final: ',body);

  let address;
  if( typeof body.address == 'string'){
     address= JSON.parse(body.address);
  }else{
    address = body.address;
  }
  
  let data;
  if(body.type == undefined){
    let cart = [];
    console.log(typeof body.products);

    if( typeof body.products == 'string'){
      cart = JSON.parse(body.products);
    }else{
      console.log('PRODUCTS: ', body.products);
      cart = body.products;

    }
    console.log("Carrito: ", cart);
    getCommerceByID(body.commerceId).then(commerce=>{
      let distance = GeoFire.distance([Number(address.lat), Number(address.lng)], [Number(commerce.val().lat), Number(commerce.val().lng)]);
      getDeliveryPrice(distance).then(delivery_price=>{
        calculateProductsPrice(cart).then(products_price=>{
          getExpectedTime(time, distance).then(expectedTime=>{
            data = {
              cart: cart,
              address: address,
              details: body.details,
              billing: {
                ci: body.ci,
                address: body.addressF,
                name: body.name
              },
              commerceId: body.commerceId,
              userId: body.uid,
              time: time.toString(),
              expected_time: expectedTime.toString(),
              phone: body.phone,
              status: 'pending',
              distance: distance, 
              delivery_price: delivery_price,
              products_total: products_price,
              shopName: commerce.val().name
            }
            firebase.database().ref('/orders/'+orderId).set(data);
          }); 
        }); 
      });  
      });
  }else{
    console.log('personalized')
    data = {
      address: address,
      details: body.details,
      billing: {
        ci: body.ci,
        adress: body.adressF,
        name: body.name
      },
      userId: body.uid,
      time: time.toString(),
      phone: body.phone,
      type: body.type,
      status: 'accepted'
    }
    firebase.database().ref('/orders/'+orderId).set(data);
  }
  let ref = firebase.database().ref('/ordersLocations').ref;
  let geoFire = new GeoFire(ref);
  let location = [Number(address.lat), Number(address.lng)];
  geoFire.set(orderId, location); 
  res.status(200).send({id:orderId});
});

exports.ordersNotifications = functions.database.ref('/orders/{order}').onWrite(event => {
  let orderData = event.data.val(); 
  let orderKey= event.data.key;
  console.log(orderData.type)
  let ids = [];
  let refActiveOrdersP = firebase.database().ref('/activeLocationsP').ref;
  let geoFireP = new GeoFire(refActiveOrdersP);
  let refBlipers = firebase.database().ref('/blipersLocations').ref;
  let geoFire = new GeoFire(refBlipers);
  if(orderData.type == 'personalized'){
    switch(orderData.status){
      case 'accepted': 
                      geoFireP.set(orderKey, [orderData.address.lat, orderData.address.lng])
                      let nearBlipers = geoFire.query({
                        center: [orderData.address.lat, orderData.address.lng],
                        radius: 4
                      });
                      console.log("Near:", nearBlipers);
                      getBlipersIds(nearBlipers, 1).then(blipersTokens=>{
                        console.log("Blipers:",blipersTokens);
                        title = "Nuevo pedido Pesonalizado";
                        message = "Mira si puedes cumplirlo";
                        sendMessageToBlipers(blipersTokens, title, message);
                      });
                      break;
      case 'assigned':
                        geoFireP.remove(orderKey);
                        getUser(orderData.userId).then((user)=>{
                          let token = [];
                          token.push(user.token);
                          sendMessageToUser(ids, "Pedido aceptado", "Tranquilo un Bliper trabaja en ello");
                        });
                        
                        break;
      case 'arrived':
                        getUser(orderData.userId).then((user)=>{
                          let token = [];
                          token.push(user.token);
                          sendMessageToUser(token, "Tu bliper ya esta afuera", "Recíbelo");
                        });
                        break;
      case 'recived':
                        getUser(orderData.userId).then((user)=>{
                          let token = [];
                          token.push(user.token);
                          sendMessageToUser(token, "Gracias!", "Califica a tu Bliper");
                        });
                        break;
    }
  }else{
    firebase.database().ref('commerces/'+ orderData.commerceId).once("value").then( commerce=>{
      let message;
      let title;
      let tokens = [];
      let refActiveOrders = firebase.database().ref('/activeLocations').ref;
      let geoFireA = new GeoFire(refActiveOrders);
      switch(orderData.status){
        case 'pending':
                        console.log("entro pending")
                        title = "Nuevo pedido";
                        message =  "Aceptalo para continuar";
                        tokens.push(commerce.val().token);
                        sendMessageToShop(tokens, title, message);
                        break;
        case 'accepted': 
                        console.log('accepted')
                        console.log("OrderKey:", orderKey);
                        console.log("lAT: ", commerce.val().lat);
                        console.log("lng",  commerce.val().lng);
                        geoFireA.set(orderKey, [commerce.val().lat, commerce.val().lng])
                        let nearBlipers = geoFire.query({
                          center: [commerce.val().lat, commerce.val().lng],
                          radius: 4
                        });
                        getBlipersIds(nearBlipers, orderData.distance).then(blipersTokens=>{
                          console.log("Blipers:",blipersTokens)
                          title = "Nuevo pedido";
                          message = "Pedido disponible en tu zona";
                          sendMessageToBlipers(blipersTokens, title, message);
                        });
                        console.log(orderData.uid);
                        getUser(orderData.userId).then((user)=>{
                          console.log(user);
                          let token = [];
                          token.push(user.token);
                          sendMessageToUser(token, "Se aprovo tu pedido", "Te estamos buscando un bliper");
                        });
                        break;
        case 'assigned':
                        console.log("assigned");
                        geoFireA.remove(orderKey);
                        break;
                        
        case 'arrived':
                        console.log("Arrived");

                        getUser(orderData.userId).then((user)=>{
                          let token = [];
                          token.push(user.token);
                          sendMessageToUser(token, "Tu bliper ya esta afuera", "Recíbelo");
                        });
                        break;
        case 'recived':
                        getUser(orderData.userId).then((user)=>{
                          let token = [];
                          token.push(user.token);
                          sendMessageToUser(token, "Gracias!", "Califica a tu Bliper");
                        });
                        break;
                        
      } 
          
    });
  }
 
});

exports.disableUser = functions.https.onRequest((req, res) => {
  const uid = req.query.uid|| '';
  console.log(uid);
  firebaseAdmin.auth().updateUser(uid, {
    disabled: true
  }).then((userRecord)=>{
    console.log("Successfully updated user", userRecord.toJSON());
  });
});

exports.enableUser = functions.https.onRequest((req, res) => {
  const uid = req.query.uid|| '';
  console.log(uid);
  firebaseAdmin.auth().updateUser(uid, {
    disabled: false
  }).then((userRecord)=>{
    console.log("Successfully updated user", userRecord.toJSON());
  });
});

exports.createBliper = functions.https.onRequest((req, res) => {
  const data = req.query;
  console.log(data);
  let firstName = data.name.split(' ')[0];

  let lastName = data.name.split(' ')[1];
  if(lastName == undefined){
    lastName = '';
  }

  firebaseAdmin.auth().createUser({
      email: data.email,
      emailVerified: false,
      password: data.password,
      displayName: data.name,
      photoURL: "http://www.example.com/12345678/photo.png",
      disabled: true
    }).then(user=>{

      firebaseAdmin.database().ref('/blipers/'+user.uid).set({
        active: false,
        city: data.city.toLowerCase(),
        disabled: true,
        name: firstName,
        last_name: lastName,
        phone: data.phone
      })
    })
});
exports.sendMessageToAllUsers = functions.https.onRequest((req, res) => {
  let message = req.query.message;
  let title = req.query.title;
  console.log('Mensaje: ',message);
  firebaseAdmin.database().ref('/users').on('value',users=>{
    console.log('Usuarios: ', users.val());
    let usersO= users.val();
    let i = 0;
    let tokens = [];
    for (var key in usersO) {
      if (usersO.hasOwnProperty(key)) {
        if(usersO[key].token != undefined){
          tokens.push(usersO[key].token);
        }
     }
    
    }
    setTimeout(()=>{
      console.log('Cantidad: ',tokens.length);
      sendMessageToUser(tokens, "No se cocina en un feriado"," Mejor quedate en casa y pide por Blip");
     },7000)
  });
});
// Funciones 

function onReady(geoQuery){  //Wait for ready event on a geoQuery
  return new Promise((resolve, reject)=>{
    geoQuery.on("ready", ()=>{
      resolve();
    });
  });
}

function getCommerces(shopsList, category, lat, lng){   // Get Info of avalible commerces
  return new Promise((resolve, reject)=>{
    let shops = [];
    let getCommerces = 0;
    for (let shopId of shopsList){
      getCommerceByID(shopId).then(commerce=>{
        let distance = GeoFire.distance([commerce.val().lat, commerce.val().lng], [lat, lng]);
        createCommerceData(commerce, category, distance, shopId).then(shopData=>{
          if(shopData.name != undefined){
            shops.push(shopData);
          }
          getCommerces++;
          if(getCommerces == shopsList.length){
            resolve(shops);
          }
        });

      });
    }
  });
}
function getCommerceByID(id){  // Get all commerce info based on ID
  return new Promise((resolve, reject)=>{
    firebase.database().ref('/commerces/'+id).on("value",commerce=>{
      resolve(commerce)
    });
  })
}

function getDeliveryPrice(distance){
  return new Promise((resolve, reject)=>{
    let price;
    if(distance <= 3.5){
      price = 2.00;
    }else{
      price = 2  + (distance - 3) * 0.30;
    }
    resolve(price)
  });
}

function isOpen(commerce){
  return new Promise((resolve, resject)=>{
    let dateMoment = moment().tz("America/Bogota");
    let day = dateMoment.day()-1;
    if(commerce.attention[day.toString()].work){
      let openS = commerce.attention[day.toString()].open;
      let closeS = commerce.attention[day.toString()].close;
      let open = moment().tz("America/Bogota").hour(Number(openS.split(':')[0])).minute(openS.split(':')[1]);
      let close = moment().tz("America/Bogota").hour(Number(closeS.split(':')[0])).minute(closeS.split(':')[1]);
      resolve(dateMoment.isBetween(open,close));
    }else{
      resolve(false);
    }
    
  });
}
function createCommerceData(commerce, category, distance, shopId){
  return new Promise((resolve,reject)=>{
    let aux ={};
    let last;
    if(commerce.val().category == category){
      isOpen(commerce.val()).then(op =>{
        getDeliveryPrice(distance).then(price=>{
          aux.delivery_price = price;
          aux.name = commerce.val().name;
          aux.description = commerce.val().description;
          aux.commerceId = shopId;
          aux.bannerUrl = commerce.val().bannerUrl;
          aux.distance = distance;
          aux.isOpen = op;
          resolve(aux);
        });
      });
    }else{
      resolve({});
    }
  });
}
function calculateProductsPrice(cart){
  let productsPrice = 0;
  return new Promise((resolve, reject)=>{
    cart.forEach(product =>{
      productsPrice += product.cant * product.price;
    });
    resolve(productsPrice);
  });
}

function getExpectedTime(time, distance){
  return new Promise((resolve, reject)=>{
    let timetToadd = 0;
    if(distance<=3.5){
      timetToadd = 35;
    }else{
      timetToadd = 40;
    }
    time.add(timetToadd, 'm');
    resolve(time);
  });
}
// Send messages
function sendMessageToShop(id, title, message) {
  console.log(id);
  request({
    url: 'https://fcm.googleapis.com/fcm/send',
    method: 'POST',
    headers: {
      'Content-Type' :' application/json',
      'Authorization': 'key=AIzaSyBwftdrK1bya0EVUNQf5wmN9n-ukHmzCpg'
    },
    body: JSON.stringify(
      { "notification": {
        "title": title,
        "body": message,
        "sound":"default",
        "show_in_foreground": true
      },
        "wasTapped":false,
        "registration_ids": id,
        "priority":"high", 
        "restricted_package_name":"com.blipclub.shops"
      }
    )
  }, function(error, response, body) {
    if (error) { 
      console.error(error, response, body); 
    }
    else if (response.statusCode >= 400) { 
      console.error('HTTP Error: '+response.statusCode+' - '+response.statusMessage+'\n'+body); 
    }
    else {
      console.log('Done!')
    }
  });
}
function sendMessageToBlipers(ids, title, message) {
  request({
    url: 'https://fcm.googleapis.com/fcm/send',
    method: 'POST',
    headers: {
      'Content-Type' :' application/json',
      'Authorization': 'key=AIzaSyBwftdrK1bya0EVUNQf5wmN9n-ukHmzCpg'
    },
    body: JSON.stringify(
      { "notification": {
        "title": title,
        "body": message,
        "sound":"default",
        "show_in_foreground": true
      },
        "wasTapped":false,
        "registration_ids": ids,
        "priority":"high", 
        "restricted_package_name":"com.blipclub.blipers"
      }
    )
  }, function(error, response, body) {
    if (error) { 
      console.error(error, response, body); 
    }
    else if (response.statusCode >= 400) { 
      console.error('HTTP Error: '+response.statusCode+' - '+response.statusMessage+'\n'+body); 
    }
    else {
      console.log('Done!')
    }
  });
}


function getBlipersIds(nearIds, distance){
  return new Promise((resolve, reject)=>{
    let tokens = [];
    let ids = [];
    if(distance >= 1.5){
      console.log("Mayor a 1.5");
      nearIds.on("key_entered", (id)=>{
        ids.push(id);
      });
      onReady(nearIds).then(()=>{
        let i = 1;
        ids.forEach(id=>{
          getBliper(id).then(bliper=>{
            if(bliper.transport == 'moto'){
              if(bliper.active){
                tokens.push(bliper.token);
              }
              
            }
            if(i == ids.length){
              console.log(tokens);
              resolve(tokens);
            }
            i++;
          });
        });
      });
    }else{
      console.log("Menor a 1.5");
      
      nearIds.on("key_entered", (id)=>{
        ids.push(id);
      });
      onReady(nearIds).then(()=>{
        console.log("Ids:", ids);
        let i = 1;
        ids.forEach(id=>{
          getBliper(id).then(bliper=>{
            if(bliper.active){
              tokens.push(bliper.token);
            }
            
            if(i == ids.length){
              console.log(tokens);
              resolve(tokens);
            }
            i++;
          });
        });
      });
     
    }
   
  });
}
function sendMessageToUser(ids, title, message) {
  request({
    url: 'https://fcm.googleapis.com/fcm/send',
    method: 'POST',
    headers: {
      'Content-Type' :' application/json',
      'Authorization': 'key=AIzaSyBwftdrK1bya0EVUNQf5wmN9n-ukHmzCpg'
    },
    body: JSON.stringify(
      { "notification": {
        "title": title,
        "body": message,
        "sound":"default",
        "show_in_foreground": true
      },
        "wasTapped":false,
        "registration_ids": ids,
        "priority":"high", 
        "restricted_package_name":"com.blipclub.blip"
      }
    )
  }, function(error, response, body) {
    if (error) { 
      console.error(error, response, body); 
    }
    else if (response.statusCode >= 400) { 
      console.error('HTTP Error: '+response.statusCode+' - '+response.statusMessage+'\n'+body); 
    }
    else {
      console.log('Done!')
    }
  });
}
function getBliper(id){
  return new Promise((resolve, reject)=>{
    firebase.database().ref('blipers/'+id).on('value', (ss)=>{
      resolve(ss.val())
    });
  });
}
function getUser(id){
  return new Promise((resolve, reject)=>{
    firebase.database().ref('users/'+id).on('value', (ss)=>{
      resolve(ss.val());
    });
  });
}
