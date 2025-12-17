require("dotenv").config();
const express = require('express')
const cors = require("cors");
const app = express()
const port = process.env.PORT || 5000;

// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());


// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};


app.get('/', (req, res) => {
  res.send('Welcome to AssetVerse Server')
})

app.listen(port, () => {
  console.log(`AssetVerse server is running on port ${port}`)
})
