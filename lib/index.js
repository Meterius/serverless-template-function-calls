const path = require("path");

class ServerlessPluginTemplateFunctionCalls {
	constructor(serverless, options){
		this.environment = { serverless, options };

		this.hooks = {
			"before:package:initialize": () => this.inplaceFormatTemplate(),
		};
	}

	// serverless template
	get template(){
		return this.environment.serverless.service;
	}

	// path to template file
	get templatePath(){
		return this.environment.serverless.config.servicePath;
	}

	// function string regex, assumes trimmed and function string to be without prefix
	// 1: functionName, 2: functionArgumentContent
	get functionStringRegex(){
		return /^(.*)\((.*)\)$/;
	}

	// return resolved possibly relative filePath in relation to the location of the template file
	resolvePath(filePath){
		return path.join(this.templatePath, filePath);
	}

	// throws formatted error with optional error parameter to be forwarded
	// [requirement] msg has to define toString
	// [requirement] err has to be error like or undefined
	throwError(msg, err){
		if(err){
			console.log("Unexpected Module Error Stack Trace:");
			console.log("-----------------------------");
			console.log(err);
			console.log("-----------------------------");
		}

		throw new Error("Template Function Calls Error: " + msg.toString());
	}

	// validate config and return error message if invalid property was detected
	// [requirement] all config properties that are necessary are not undefined
	validateConfig(config)  {
		const { functionPrefix, modules, roots } = config;

		if(typeof functionPrefix !== "string"){
			return "functionPrefix has to be a string";
		} else if(!Array.isArray(modules) || !modules.every(module => typeof module === "string")) {
			return "modules has to be a string array";
		} else if(!Array.isArray(roots) || !modules.every(module => typeof module === "string")) {
			return "roots has to be a string array";
		} else {
			return undefined;
		}
	}

	// returns config with default values
	getDefaultConfig() {
		return {
			modules: [],
			functionPrefix: "+",
			roots: ["resources", "functions", "custom", "layers", "service", "provider", "plugins", "outputs"],
		};
	}

	// return from custom.templateFunctionCalls constructed config and throw if it is invalid
	getConfig() {
		// read custom.templateFunctionCalls from the template
		const custom = this.template.custom || {};
		const configInput = custom.templateFunctionCalls || {};

		const config = this.getDefaultConfig();

		// ignore irrelevant properties and overwrite default with specific config values
		Object.keys(config).forEach((key) => {
			if(Object.keys(configInput).includes(key)){
				config[key] = configInput[key];
			}
		});

		// [property] config properties that are necessary are provided with default values

		// validate config and throw error if invalid
		let validationErrorMsg = this.validateConfig(config);
		if(validationErrorMsg){
			this.throwError(validationErrorMsg);
		}

		return config;
	}

	// returns object where keys correspond to filename without extensions and values to their module exports
	// throws error if import was not found or module itself threw
	// [requirement] module paths is an array of absolute file paths
	loadModules(modulePaths){
		const modules = {};
		modulePaths.forEach((modulePath) => {
			// get filename by taking the basename and removed the extension
			const moduleFilename = path.basename(modulePath, path.extname(modulePath));

			// import module or handle error and throw
			try {
				modules[moduleFilename] = require(modulePath);
			} catch (err) {
				if(err.code === "MODULE_NOT_FOUND"){
					this.throwError("module \"" + modulePath + "\" not found");
				} else {
					this.throwError("module " + moduleFilename + " thew an error", err);
				}
			}
		});

		return modules;
	}

	// returns object where keys correspond to formatted function names by which they will be referenced in the templates
	// and values to their functions that replace the content
	// [requirement] modules is an object with key/value pairs of the module filename without extension and the module exports
	formatModules(modules){
		const functions = {};

		// retrieve all functions from all modules and add them to functions
		Object.keys(modules).forEach((moduleFile) => {
			// recursively retrieve functions and add them to the functions object
			const takeFunctions = (prefix, container) => {
				if(typeof container === "object" && container !== null){
					Object.keys(container).forEach((key) => {
						takeFunctions(prefix + "." + key, container[key]);
					});
				} else if(typeof container === "function"){
					functions[prefix] = container;
				}
			};
			takeFunctions(moduleFile, modules[moduleFile]);
		});

		return functions;
	}

	// returns object where keys correspond to the function names and values to their functions defined by the config
	// [requirement] all config properties are validated
	loadFunctions(config){
		// construct array of all module paths for the require node call from the config
		const modulePaths = config.modules.map(modulePath => this.resolvePath(modulePath));

		// retrieve modules, which might throw
		const modules = this.loadModules(modulePaths);

		// retrieve functions from modules and return them
		return this.formatModules(modules);
	}

	// if functionString is encoded function call
	// returns object with functionName and functionArgumentContent (string between parentheses)
	// else returns undefined
	// [requirement] functionString is string and unprefixed
	decodeUnprefixedFunctionString(functionString){
		const functionCallMatch = functionString.match(this.functionStringRegex);

		// function regex didnt match, it therefore cant be a encoded function call
		if(!functionCallMatch){
			return undefined;
		}

		// extract the function name and function argument content given by the regex description
		// and return the formatted object
		const { 1: functionName, 2: functionArgumentContent } = functionCallMatch;
		return { functionName, functionArgumentContent };
	}

	// if argument content are encoded function arguments
	// returns an array of the decoded function arguments
	// else returns undefined
	// [requirement] argumentContent is string
	decodeFunctionArgumentContent(argumentContent){
		// make sure argument content is empty in case of no arguments
		argumentContent = argumentContent.trim();

		const args = [];

		// use state machine to read each argument and add it to args or return undefined if it is argument content is malformed
		let currArgument = undefined, afterComma = true;
		for(let i = 0; i < argumentContent.length; i++){
			const next = argumentContent[i];

			if(currArgument === undefined && afterComma){ // state: expects start of next argument
				if(next === "\""){
					currArgument = ""; // found start of next argument
				} else if(!next.match(/\s/)){
					return undefined; // malformed argument content since only whitespace characters or " were expected
				}
			} else if(currArgument !== undefined && afterComma){ // state: inside of next argument
				if(next === "\\"){
					i++; // add and skip escaped character
					currArgument += argumentContent[i];
				} else if(next === "\""){
					// finish current argument by adding it since the closing " was found
					args.push(currArgument);
					currArgument = undefined;
					afterComma = false;
				} else {
					// add unescaped character
					currArgument += next;
				}
			} else if(currArgument === undefined && !afterComma){ // state: awaits end or comma to separate argument
				if(next === ","){
					afterComma = true; // found separator of next argument
				} else if(!next.match(/\s/)){
					return undefined; // malformed argument content since only whitespace characters or , were expected
				}
			} else {
				return undefined; // invalid state
			}
		}

		return args;
	}

	// checks whether functionString is actual function call specified by the plugin functionality
	// if it is returns object with
	// 			returnValue (returned data by function call),
	// 			functionName (name without prefix)
	//			function (the called js function)
	// 			nestedFunctionName (name without namespace specifier)
	// 			arguments (specified for that function in the string)
	// else returns undefined
	// throws if function string is function, but there is still some malformation
	// [requirement] functionString has to be a string
	// [requirement] functions has to be an object and its values only functions
	processFunctionString(functionString, functions, config){
		functionString = functionString.trim();

		// check for specified function prefix
		if(functionString.substring(0, config.functionPrefix.length) !== config.functionPrefix){
			return undefined;
		}

		// remove the prefix
		functionString = functionString.substring(config.functionPrefix.length);

		// try to decode the function and return if it is not a function call
		const decodedFunctionCall = this.decodeUnprefixedFunctionString(functionString);
		if(!decodedFunctionCall){
			return undefined;
		}

		// extract properties from the decoded object, described by the decode function
		const { functionName, functionArgumentContent } = decodedFunctionCall;

		// extract nested function name
		const nestedFunctionName = functionName.substring(Math.min(0, functionName.lastIndexOf(".")));

		// try to decode the function arguments and throw if it is malformed
		const functionArguments = this.decodeFunctionArgumentContent(functionArgumentContent);
		if(!functionArguments){
			this.throwError("arguments of " + functionString + " were malformed");
		}

		// check if function is found, throw if not
		const callFunction = functions[functionName];
		if(!callFunction){
			this.throwError("function \"" + functionName + "\" is called but not found");
		}

		// call function and return or handle error and throw
		try {
			let returnValue = callFunction(...functionArguments);

			return {
				returnValue,
				function: callFunction,
				functionName,
				nestedFunctionName,
				arguments: functionArguments
			}
		} catch(err){
			this.throwError("function call to \"" + functionName + "\" with the argument ..." + JSON.stringify(functionArguments) + " threw an error", err);
		}
	}

	// transform the current serverless stored template inplace specified by the plugin functionality
	inplaceFormatTemplate(){
		const config = this.getConfig();
		const functions = this.loadFunctions(config);

		// recursively execute functions for each template root specified in the config
		config.roots.forEach((templateProperty) => {
			const inplaceFormatField = (parent, key) => {
				const child = parent[key];

				if(typeof child === "object" && child !== null){
					// call the replacer for all childs of the child
					Object.keys(child).forEach((childKey) => {
						inplaceFormatField(child, childKey);
					});
				} else if(typeof child === "string"){
					// process function string and if it was a call, replace the function string
					const callInfo = this.processFunctionString(child, functions, config);
					if(callInfo){
						parent[key] = callInfo.returnValue;
					}
				}
			};

			inplaceFormatField(this.template, templateProperty);
		});
	}
}

module.exports = ServerlessPluginTemplateFunctionCalls;
