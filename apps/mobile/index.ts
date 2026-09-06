import { registerRootComponent } from "expo";
import "react-native-get-random-values";
import "./src/polyfills/crypto";
import "./src/polyfills/text-decoder";
import App from "./App";

registerRootComponent(App);
