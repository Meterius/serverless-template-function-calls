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

	// return wether val is an object
	isObject(val){
		return typeof val === "object" && val !== null;
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
	loadModules(modulePaths, config){
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
	formatModules(modules, config){
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

		// provide optional short function names as aliases
		Object.keys(functions).forEach((functionName) => {
			const shortFunctionName = functionName.match(/([^.]*)$/)[1];

			if(!functions[shortFunctionName]){
				functions[shortFunctionName] = functions[functionName];
			}
		});

		return functions;
	}

	// returns object where keys correspond to the function names and values to their functions defined by the config
	// [requirement] all config properties are validated
	loadFunctions(config){
		// construct array of all module paths for the require node call from the config
		const modulePaths = config.modules.map(modulePath => this.resolvePath(modulePath));

		// retrieve modules, which might throw
		const modules = this.loadModules(modulePaths, config);

		// retrieve functions from modules and return them
		return this.formatModules(modules, config);
	}

	// if functionString is encoded function call
	// returns object with functionName and functionArgumentContent (string between parentheses)
	// else returns undefined
	decodeFunctionString(functionString, config){
		// check whether prefix is included in string
		if(functionString.substr(0, config.functionPrefix.length) !== config.functionPrefix){
			return undefined;
		}

		// remove the prefix for further processing
		functionString = functionString.substr(config.functionPrefix.length);

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

	// returns an array of the decoded function arguments
	// else returns undefined if arguments are malformed
	decodeFunctionArgumentString(argumentContent, config){
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

	// returns value of function call
	// throws if function was not found or function call threw
	executeFunction(functionName, functionArguments, functions, config){
		const functionInstance = functions[functionName];

		if(!functionInstance){
			this.throwError("function \"" + functionName + "\" was not found");
		}

		try {
			return functionInstance(...functionArguments);
		} catch(err) {
			this.throwError("function call to \"" + functionName + "\" with the argument ..." + JSON.stringify(functionArguments) + " threw an error", err);
		}
	}

	// processes key value pair and checks whether they are encodeded function calls
	// if they are returns object with returnValue and isKeyFunction as keys
	// else returns undefined
	processTemplateKeyValue(key, value, functions, config){
		const keyAsFunction = this.decodeFunctionString(key, config);

		// make sure value is a string before trying to decode
		const valAsFunction = typeof value === "string" ? this.decodeFunctionString(value, config) : undefined;

		let valFuncReturn;

		if(valAsFunction){
			// try decoding the function argument content, which is necessary for value encoded function call
			const args = this.decodeFunctionArgumentString(valAsFunction.functionArgumentContent, config);

			if(args){
				valFuncReturn = this.executeFunction(valAsFunction.functionName, args, functions, config);
			} else {
				this.throwError("arguments of " + value + " were malformed");
			}
		}

		if(keyAsFunction){
			// use either the value function call return or the actual template value as arguments
			const args = valAsFunction ? [valFuncReturn] : [value];

			// execute function and return or throw
			return {
				isKeyFunction: true,
				returnValue: this.executeFunction(keyAsFunction.functionName, args, functions, config)
			}
		} else {
			// return value function call return or undefined if none was found
			return valAsFunction ? {
				isKeyFunction: false,
				returnValue: valFuncReturn
			} : undefined;
		}
	}

	// transform the current serverless stored template inplace specified by the plugin functionality
	inplaceFormatTemplate(){
		const config = this.getConfig();
		const functions = this.loadFunctions(config);

		// recursively execute functions for each template root specified in the config
		config.roots.forEach((templateProperty) => {
			const inplaceFormatField = (parent, key) => {
				const element = parent[key];

				if(this.isObject(element)){
					Object.keys(element).some((elementKey) => {
						inplaceFormatField(element, elementKey);

						const info = this.processTemplateKeyValue(elementKey, element[elementKey], functions, config);

						// replace inline or parent if key/value encoded function call was found
						if(info && info.isKeyFunction){
							parent[key] = info.returnValue;
							return true; // skip further childs, since parent was replaced
						} else if(info && !info.isKeyFunction){
							element[elementKey] = info.returnValue;
						}

						return false;
					});
				}
			};

			inplaceFormatField(this.template, templateProperty);
		});
	}
}

module.exports = ServerlessPluginTemplateFunctionCalls;
