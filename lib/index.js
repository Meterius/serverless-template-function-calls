const path = require("path");
const fs = require("fs");

/**
 * creates deep copy of objects, arrays and leaves everything else,
 * that means that more advanced objects might have problems with being copied
 * @param {*} val
 */
function deepCopy(val){
	if(Array.isArray(val)){
		return val.map(deepCopy);
	} else if(val && typeof val === "object"){
		const valCopy = {};

		Object.keys(val).forEach((key) => { valCopy[key] = deepCopy(val[key]); });

		return valCopy;
	} else {
		return val; // leave functions and elementary values unchanged
	}
}

/**
 * @param {Object} object
 * @param {String[]} position
 * @returns value of the node the position refers to on the given object
 */
function applyPosition(object, position){
	let node = object;
	position.forEach((prop) => { node = node[prop]; });
	return node;
}

class ServerlessTemplateContext {
	/**
	 * constructs a template context used for each function execution
	 * @param {Object} template - a copy of the template roots
	 * @param {Array} position - array of the properties from rootTree to function position
	 */
	constructor(template, position){
		this.template = deepCopy(template);
		this.position = position;
		this.ancestry = this.__createAncestry();
	}

	/**
	 * constructs ancestry tree
	 * @returns {Object[]} - ancestry tree
	 * @private
	 */
	__createAncestry(){
		// the tree root is the template
		const elements = [{
			key: undefined,
			value: this.template,
			parent: undefined,
		}];

		let parent = elements[0]; // keep track of the previous child, therefore the parent of the next node
		this.position.forEach((childKey) =>{
			const element = {
				key: childKey,
				value: parent.value[childKey],
				parent,
				child: undefined
			};

			parent.child = element;

			elements.push(element);
		});

		return elements;
	}

	/**
	 * the ancestry tree is a single node tree traversable by the nodes parent and child keys,
	 * and provides key and value keys for the properties of the template that are traversed.
	 * the nodes go from the template to function call property.
	 * @returns {Object[]} - returns array of the nodes of the ancestry tree
	 */
	getAncestry(){
		return this.ancestry;
	}

	/**
	 * @returns {Object} - returns the function node of the ancestry
	 */
	getAncestryFunction(){
		return this.ancestry[this.ancestry.length - 1];
	}

	/**
	 * @returns {*} - template
	 */
	getTemplate(){
		return this.template;
	}

	/**
	 * @returns {*} - template root the function call is contained in
	 */
	getRoot(){
		return this.template[this.position[0]];
	}
}

class ServerlessPluginTemplateFunctionCalls {
	constructor(serverless, options){
		this.environment = { serverless, options };

		this.hooks = {
			"before:package:initialize": () => this.processTemplate(),
		};

		process.chdir(this.resolvePath("./"));
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
		return /^(?<functionName>[^(]*)\((?<functionArgumentContent>.*)\)$/;
	}

	// return whether val is an object
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
		const modulePaths = config.modules.map(modulePath => {
			return this.resolvePath(modulePath);
		});

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
		const { groups: { functionName, functionArgumentContent } } = functionCallMatch;
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
	executeFunction(functionName, functionArguments, template, position, functions, config){
		const functionInstance = functions[functionName];

		const ctx = new ServerlessTemplateContext(template, position);

		if(!functionInstance){
			this.throwError("function \"" + functionName + "\" was not found");
		}

		try {
			return functionInstance.bind({
				serverlessContext: ctx
			})(...functionArguments);
		} catch(err) {
			this.throwError("function call to \"" + functionName + "\" with the argument ..." + JSON.stringify(functionArguments) + " threw an error", err);
		}
	}

	// processes key value pair and checks whether they are encoded function calls
	// if they are returns object with returnValue and isKeyFunction as keys
	// else returns undefined
	processTemplateKeyValue(template, position, functions, config){
		const key = position[position.length - 1], value = applyPosition(template, position);

		const keyAsFunction = this.decodeFunctionString(key, config);

		// make sure value is a string before trying to decode
		const valAsFunction = typeof value === "string" ? this.decodeFunctionString(value, config) : undefined;

		let valFuncReturn;

		if(valAsFunction){
			// try decoding the function argument content, which is necessary for value encoded function call
			const args = this.decodeFunctionArgumentString(valAsFunction.functionArgumentContent, config);

			if(args){
				valFuncReturn = this.executeFunction(valAsFunction.functionName, args, template, position, functions, config);
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
				returnValue: this.executeFunction(keyAsFunction.functionName, args, template, position, functions, config)
			}
		} else {
			// return value function call return or undefined if none was found
			return valAsFunction ? {
				isKeyFunction: false,
				returnValue: valFuncReturn
			} : undefined;
		}
	}

	/**
	 * applies function calls recursively
	 * @param {Object} template
	 * @param {String[]} position
	 * @param {Array} functions
	 * @param {Object} config
	 */
	inplaceFormatField(template, position, functions, config){
		const element = applyPosition(template, position);
		const parent = position.length > 0 ? applyPosition(template, position.slice(0, position.length - 1)) : undefined;
		const key = position.length > 0 ? position[position.length - 1] : undefined;

		if(this.isObject(element)){
			Object.keys(element).some((childKey) => {
				const childPosition = position.concat([childKey]);

				this.inplaceFormatField(template, childPosition, functions, config);

				if(position.length > 0) {
					const info = this.processTemplateKeyValue(template, childPosition, functions, config);

					// replace inline or parent if key/value encoded function call was found
					if (info && info.isKeyFunction) {
						parent[key] = info.returnValue;
						this.inplaceFormatField(template, position.slice(0), functions, config); // rerun processing on new parent value
						return true; // skip further childs, since parent was replaced
					} else if (info && !info.isKeyFunction) {
						element[childKey] = info.returnValue;
						this.inplaceFormatField(template, childPosition, functions, config); // rerun processing on new value
					}
				}

				return false;
			});
		}
	}

	// transform the current serverless stored template inplace specified by the plugin functionality
	processTemplate(){
		const config = this.getConfig();
		const functions = this.loadFunctions(config);

		// create deep copy that enables traversing all roots
		let rootsTree = {};
		config.roots.forEach((root) => { rootsTree[root] = this.template[root]; });

		// recursively execute functions for each template root specified in the config
		this.inplaceFormatField(rootsTree, [], functions, config);
	}
}

module.exports = ServerlessPluginTemplateFunctionCalls;
