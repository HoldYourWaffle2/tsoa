export abstract class Controller {
  private statusCode?: number = undefined;
  private headers = {} as { [name: string]: string | undefined };

  /*
    XXX should these methods be protected instead of public?
    This would technically be a breaking change but I think you're not supposed to use them outside your controller
  */

  public setStatus(statusCode: number) {
    this.statusCode = statusCode;
  }

  public getStatus() {
    return this.statusCode;
  }

  public setHeader(name: string, value?: string) {
    this.headers[name] = value;
  }

  public getHeader(name: string) {
    return this.headers[name];
  }

  public getHeaders() {
    return this.headers;
  }
}
