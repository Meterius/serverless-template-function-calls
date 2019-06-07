const path = require("path");

class ServerlessPluginTemplateFunctionCalls {
	constructor(serverless, options){
		this.hooks = {
			"before:package:initialize": () => { this.format(serverless); },
		};

		this.resolve = (filePath) => path.join(serverless.config.servicePath, filePath);

		this.functionRegex = /^([a-zA-Z]*)\((.*)\)$/;
		this.argumentRegex = /^\s*"(.*)"\s*/;
		this.argumentSeperationRegex = /^,/;

		this.functions = {};
	}

	format(serverless){
		const service = serverless.service;

		this.loadConfig(service.custom && service.custom.templateFunctionCalls);

		this.invokeRecursive(service);
	}

	loadConfig(config = {}){
		if(config.modules){
			if(!Array.isArray(config.modules)){
				throw new Error("Serverless Template Function Calls: modules has to be an array");
			}

			config.modules.forEach((modulePath) => {
				modulePath = this.resolve(modulePath);
				const module = require(modulePath);

				if(typeof module === "object"){
					Object.keys(module).forEach((exportKey) => {
						this.functions[exportKey] = module[exportKey];
					})
				} else if(typeof module === "function"){
					const moduleFileName = path.basename(modulePath, path.extname(modulePath));
					this.functions[moduleFileName] = module;
				}
			});
		}

		console.log(this.functions);
	}

	invokeFunctionMatch(functionMatch){
		let { 1: name, 2: argumentContent } = functionMatch;

		if(this.functions[name]){
			const args = this.convertArgumentContent(argumentContent);
			return this.functions[name](...args);
		} else {
			return undefined;
		}
	}

	invokeRecursive(parent) {
	}

	convertArgumentContent(argumentContent){
		const args = [];
		let hasMoreArgs = argumentContent.trim().length > 0;

		while(hasMoreArgs){
			const argMatch = argumentContent.match(this.argumentRegex);

			if(!argMatch){
				throw new Error("Serverless Template Function Calls: function arguments of \"" + parent + "\" are malformed");
			}

			argumentContent = argumentContent.substr(argMatch.index);
			const argSepMatch = argumentContent.match(this.argumentSeperationRegex);

			if(argSepMatch){
				hasMoreArgs = true;
				argumentContent = argumentContent.substr(argSepMatch.index);
			} else {
				hasMoreArgs = false;
			}
		}

		return args;
	}
}

module.exports = ServerlessPluginTemplateFunctionCalls;
